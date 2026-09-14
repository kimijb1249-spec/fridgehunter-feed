// 레시피 영상 수집 · 검수 파이프라인 (docs/DESIGN.md §56).
//
// 🔴 앱 필터와 수집 필터는 다르다.
//    - 앱 필터: 한 끼·디저트·10분·전자레인지… 사용자가 고르는 기준(태그).
//    - 수집 필터: 앱에 넣어도 되는 영상인지 판별하는 기준(이 파일).
//    영상 길이는 조리 시간 분류 기준이 아니다. 「영상 3분 = 요리 3분」으로 추정하지 않는다.
//
// 흐름: allowlist 채널 RSS(키·한도 없음) → [키가 있을 때만] Data API 검색·검증 → 제외 규칙
//       → 자동 태그 → 레시피 이름 매칭 → 검수 오버레이(reviews.json) → src/data/videos.json
//
// 🔴 초기 운영은 allowlist 채널 + 레시피명 검색 결과만. 무작위 전체 검색 결과는 노출하지 않는다.
// 🔴 YouTube API 키는 여기(수집 스크립트)에만. 앱 클라이언트에는 절대 넣지 않는다.
//    지금은 키가 없어 API 경로는 잠자고 있다(MVP 범위 밖, 후속 단계).
//
//   node feed/build.mjs                      → src/data/videos.json (앱 번들 샘플)
//   YOUTUBE_API_KEY=… node feed/build.mjs    → 위 + Data API 검색·검증
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// 🔴 이 파일의 정본은 공개 저장소 fridgehunter-feed다(2026-09-13, §57). 앱 저장소의 feed/는 개발용 사본.
const HERE = new URL('./', import.meta.url);
const OUT = new URL('videos.json', HERE); // 원격 피드: 승인분 전부(채널당 상한), 앱이 매일 받는다.
const STATE = new URL('state.json', HERE); // 전체 상태(제외·대기·설명 포함). 다음 실행의 합치기 기준.
const CHANNELS = new URL('channels.json', HERE); // allowlist
const KEEP_DAYS = 730; // 업로드 전체를 받으면 2년치. 메타데이터는 30일마다 갱신(refreshDueAt).
const REFRESH_DAYS = 30; // 메타데이터(제목·채널명·썸네일) 30일 안에 갱신 또는 삭제(정책 8).
const MAX_VIDEOS = 20000; // 상태 파일 상한
const MAX_PER_CHANNEL = 150; // 🔴 조회수 상위로만 자르면 큰 채널이 독식한다(실측: 뚝딱이형 333, 만개의레시피 1).
const MAX_APP_VIDEOS = 15000; // 원격 피드 상한. JSON ≈ 11MB, gzip ≈ 2MB. 앱은 하루 한 번 받는다.
const API_SEARCHES_PER_RUN = 24;

const channels = JSON.parse(readFileSync(CHANNELS, 'utf8')).filter((c) => c.enabled);
const ingredients = JSON.parse(readFileSync(new URL('ingredients.json', HERE), 'utf8'));
const recipeNames = JSON.parse(readFileSync(new URL('recipe-names.json', HERE), 'utf8')); // 앱 레시피 이름(id·name)
const reviews = existsSync(new URL('reviews.json', HERE)) ? JSON.parse(readFileSync(new URL('reviews.json', HERE), 'utf8')) : {};

// ── 3. 자동 제외 후보 ─────────────────────────────────────────────
// 제목 키워드만으로 확정하지 않는다. 확실한 것만 excluded, 애매한 것은 needs_review.
const EXCLUDE = [
  [/먹방|mukbang|eating show/i, 'mukbang'],
  [/브이로그|vlog/i, 'vlog'],
  [/라이브|live\b|생방송|실시간/i, 'live'],
  [/리뷰|언박싱|unboxing|내돈내산/i, 'product_review'],
  [/재업|재업로드|reupload/i, 'reupload'],
];
const REVIEW = [
  // 🔴 /AD\b/i는 "Bread"의 ad에도 걸렸다(실측: 쿠킹트리 바나나 브레드). 대문자 AD만.
  [/광고|협찬|유료|\bAD\b|sponsored|paid promotion|공동구매|공구\b/, 'ad_or_sponsored'],
  [/#shorts|shorts/i, 'shorts'],
  [/맛집|식당|여행|출장|시장/i, 'not_recipe'],
  [/챌린지|밈|meme|ASMR/i, 'meme'],
];
const RECIPE_HINT = /레시피|만들기|만드는|요리|황금|비법|초간단|간단|한 끼|한끼|반찬|국|찌개|볶음|무침|조림|구이|찜|튀김|디저트|베이킹|안주/;

const DESC_AD = /유료광고|유료 광고|공동구매|#공구|협찬/;
function judge(v) {
  const t = v.title;
  // 제목에 한글이 없으면 뺀다(2026-09-13, 사장님). 영어로 한식을 소개하는 채널·「Find 3 differences」 게임 쇼츠가
  // 조회수순 상위를 덮었다. 해시태그만 영어인 건 한글이 남아 있으니 통과.
  if (!/[가-힣]/.test(t)) return { status: 'excluded', reason: 'non_korean_title' };
  for (const [re, reason] of EXCLUDE) if (re.test(t)) return { status: 'excluded', reason };
  // 설명에 유료광고·공동구매 표시가 있으면 사람이 본다 — 레시피 영상에 붙은 협찬 고지일 수도 있다.
  if (DESC_AD.test(v.description || '')) return { status: 'needs_review', reason: 'ad_or_sponsored' };
  if (v.live) return { status: 'excluded', reason: 'live' };
  if (v.embeddable === false) return { status: 'excluded', reason: 'not_embeddable' };
  if (v.privacy && v.privacy !== 'public') return { status: 'excluded', reason: 'not_public' };
  for (const [re, reason] of REVIEW) if (re.test(t)) return { status: 'needs_review', reason };
  // 레시피 냄새가 전혀 없고 재료도 안 잡히면 사람이 본다.
  // 제목에 단서가 없어도 설명에 「재료」「레시피」가 있으면 레시피 영상으로 본다.
  if (!RECIPE_HINT.test(t) && v.ingredients.length === 0 && !/재료|레시피|만드는 법|만들기|recipe/i.test(v.description || ''))
    return { status: 'needs_review', reason: 'unclear_title' };
  return { status: 'approved', reason: null };
}

// ── 5. 앱 자체 태그 (YouTube 카테고리에 기대지 않는다) ─────────────
const TAGS = {
  occasion: [
    [/디저트|케이크|쿠키|빵|마카롱|푸딩|타르트|스콘|머핀|브라우니/, 'dessert'],
    [/안주|맥주|소주|와인|야식/, 'drinking_food'],
    [/간식|떡볶이|토스트|핫도그|샌드위치|김밥|주먹밥/, 'snack'],
    [/반찬|밑반찬|장아찌|무침|나물|김치|조림/, 'side_dish'],
    [/다이어트|저칼로리|건강|샐러드|비건|저염|단백질/, 'healthy'],
    [/손님|잔치|명절|추석|설날|파티|주말/, 'guest'],
    [/냉장고 털이|냉장고털이|남은|자투리|처리/, 'fridge_clear'],
    [/한 끼|한끼|덮밥|볶음밥|찌개|국|파스타|면|라면|카레|비빔밥/, 'meal'],
  ],
  equipment: [
    [/전자레인지|전자렌지/, 'microwave'],
    [/에어프라이어|에어프라이기/, 'air_fryer'],
    [/오븐/, 'oven'],
    [/불 없이|불없이|노오븐|안 익히|생/, 'no_heat'],
    [/냄비|국|찌개|탕|끓/, 'pot'],
    [/팬|볶|부침|전\b|구이|굽/, 'pan'],
  ],
  method: [
    [/볶음|볶/, 'stir_fry'],
    [/국|찌개|탕|수프|스프/, 'soup'],
    [/샐러드|무침|나물/, 'salad'],
    [/구이|굽|스테이크|바비큐/, 'grill'],
    [/조림|졸/, 'braise'],
    [/찜/, 'steam'],
    [/면|국수|파스타|라면|우동|짜장|비빔국수/, 'noodle'],
    [/베이킹|케이크|빵|쿠키|굽는 디저트/, 'baking'],
  ],
  mission: [
    [/남은 밥|찬밥|남은밥/, 'leftover_rice'],
    [/냉동|얼린|얼음/, 'freezer_clear'],
    [/재료 3개|재료 세 개|3가지 재료|세 가지 재료|재료 두 개|2가지 재료/, 'three_ingredients'],
    [/처리|털이|남은|자투리|시들|상하기 전/, 'urgent_use'],
  ],
};
function tagAll(title) {
  const out = {};
  for (const [key, rules] of Object.entries(TAGS)) {
    out[key] = [...new Set(rules.filter(([re]) => re.test(title)).map(([, t]) => t))];
  }
  // 형식: 1분·쇼츠·먹음직 편집은 발견용, 「따라하기」·단계 설명은 실행용. 모르면 inspiration.
  out.format = /따라|단계|과정|자세히|초보|처음부터|레시피/.test(title) ? 'follow_along' : 'inspiration';
  return out;
}

// ── 요리 이름(dish) · 채널이 적은 조리 시간 ─────────────────────────
// 제목이 낚시("이게 맛이 없으면 본인 혀가…")여도 설명 첫 줄에는 요리 이름이 있다. 채널마다 버릇이 있다.
const DISH_PATTERNS = [
  /^\s*(?:매콤한 |초간단 |간단 |바삭한 |촉촉한 )?([가-힣A-Za-z·\s]{2,20}?)(?:을|를)? 만들어 보자/, // 자취요리신
  /(?:초간단 |매콤한 )?([가-힣A-Za-z·\s]{2,20}?) 레시피입니다/, // 1분요리 뚝딱이형
  /오늘은 ([가-힣A-Za-z·\s]{2,20}?) 레시피를/, // 김대석 셰프TV
  /\[([가-힣A-Za-z·\s]{2,20})\]\s*\d+인분/, // 백종원
  /([가-힣A-Za-z·\s]{2,24}?)\(\d+인분\s*\/\s*\d+분/, // 만개의레시피 「쫄볶이(1인분/20분 …」
];
function dishOf(v) {
  const d = (v.description || '').replace(/\s+/g, ' ');
  for (const re of DISH_PATTERNS) {
    const m = re.exec(d);
    if (m) return m[1].trim();
  }
  return null;
}
// 🔴 조리 시간은 영상 길이가 아니다. **만든 사람이 스스로 밝힌 것**만 받고 출처를 남긴다:
//    설명의 「(1인분/20분)」「조리시간 15분」, 제목의 「10분 만에」「5분컷」「3분 완성」.
//    검수(reviews.json)가 적으면 그게 이긴다. 실측(2026-09-12): 승인 1,169 중 47개. 그 이상은
//    사람이 보거나 LLM이 읽어야 한다 — 제작자 대부분은 시간을 안 적는다.
const TIME_PATTERNS = [
  /\d+인분\s*\/\s*(\d{1,3})\s*분/,
  /(?:조리|소요|요리)\s*시간\s*[:：]?\s*(?:약\s*)?(\d{1,3})\s*분/,
  /⏱\s*(\d{1,3})\s*분/,
  /(\d{1,3})\s*분\s*(?:만에|안에|이면|컷|완성|요리|레시피|만들기|밥상|한\s?끼|뚝딱|초간단|간단)/,
];
function channelCookMinutes(v) {
  // 채널 이름 「1분요리 뚝딱이형」이 설명마다 들어가 1분으로 잡힌다 — 지우고 본다.
  const text = `${v.title || ''} ${v.description || ''}`.replace(/1분\s*요리\s*뚝딱이형|1분\s*요리/g, ' ');
  for (const re of TIME_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 180) return n;
    }
  }
  return null;
}
// 설명의 「[재료] …」 구간. 없으면 빈 문자열.
function ingredientText(v) {
  const d = (v.description || '').replace(/\s+/g, ' ');
  const m =
    /\[재료\]\s*(.+?)(?:\[만드는 법\]|\[만드는법\]|📃|$)/.exec(d) ||
    /📃\s*재료\s*(.+?)(?:✔|\[만드는|만드는 법|$)/.exec(d) ||
    /재료\s*[:：]\s*(.+?)(?:\.|$)/.exec(d);
  return m ? m[1].slice(0, 200) : '';
}

// ── 재료 태그 · 레시피 매칭 ──────────────────────────────────────
const TAGGABLE = ingredients.filter((i) => i.name.length >= 2 && i.cat !== '양념').sort((a, b) => b.name.length - a.name.length);
function tagIngredients(title) {
  const found = [];
  let rest = title;
  for (const i of TAGGABLE) {
    if (rest.includes(i.name)) {
      found.push(i.name);
      rest = rest.split(i.name).join(' ');
    }
  }
  return found;
}
// 레시피 이름(3글자 이상)이 제목에 통째로 들어 있으면 잇는다. 긴 이름 우선(「김치볶음밥」 > 「볶음밥」).
// 🔴 2글자는 오탐이다 — 「아삭」이라는 레시피가 「아삭한 열무김치」에 붙었다(실측). 2글자 레시피(잡채·팥죽)는 검수로 잇는다.
const RECIPE_NAMES = recipeNames.filter((r) => r.name.length >= 3).sort((a, b) => b.name.length - a.name.length);
function matchRecipe(title) {
  const compact = title.replace(/\s+/g, '');
  const hit = RECIPE_NAMES.find((r) => compact.includes(r.name.replace(/\s+/g, '')));
  return hit ? hit.id : null;
}

// ── 1. RSS ─────────────────────────────────────────────────────────
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
function parseRss(xml, channel) {
  const out = [];
  for (const entry of xml.split('<entry>').slice(1)) {
    const g = (re) => (entry.match(re) || [])[1];
    const id = g(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!id) continue;
    out.push({
      id,
      title: unesc(g(/<title>([^<]*)<\/title>/) || ''),
      channel: channel.channel_name,
      channelId: channel.channel_id,
      publishedAt: (g(/<published>([^<]+)<\/published>/) || '').slice(0, 10),
      views: Number(g(/<media:statistics views="(\d+)"/) || 0),
      thumb: g(/<media:thumbnail url="([^"]+)"/) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      // 설명 앞부분. 검수(reviews.json)에서 제목만으로 애매한 것을 판단하는 근거. 앱에는 안 싣는다.
      description: unesc((g(/<media:description>([\s\S]*?)<\/media:description>/) || '').trim()).slice(0, 300),
      // RSS에는 없는 값. videos.list로 검증하기 전까지 「모름」.
      durationSec: null,
      embeddable: null,
      madeForKids: null,
      privacy: null,
      live: false,
      source: 'rss',
    });
  }
  return out;
}
async function fetchRss(channel) {
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channel_id}`, {
      headers: { 'user-agent': 'fridgehunter-feed/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = parseRss(await res.text(), channel);
    channel.last_synced_at = new Date().toISOString();
    console.log(`rss  ${channel.channel_name}: ${rows.length}`);
    return rows;
  } catch (e) {
    console.warn(`rss  ${channel.channel_name}: 실패 (${e.message})`);
    return [];
  }
}

// ── 2. YouTube Data API (키가 있을 때만 — 지금은 잠자는 코드) ──────
// 🔴 풀이 얇은 진짜 이유: RSS는 채널당 최신 15개뿐이다(17채널 → 143개, 사장님 지적 2026-09-12).
//    키가 있으면 채널의 **업로드 전체**를 playlistItems.list로 가져온다 — 검색(100유닛)과 달리
//    **50개당 1유닛**이라 17채널 수천 개를 긁어도 하루 한도(10,000)의 몇 %다.
const UPLOADS_MAX_PER_CHANNEL = 300; // 채널당 최근 300개. 1채널 = 6유닛. 62채널 ≈ 370유닛 + videos.list ≈ 370유닛.
async function fetchUploads(key, channel) {
  // 업로드 재생목록 id는 채널 id의 'UC' → 'UU'.
  const playlistId = 'UU' + channel.channel_id.slice(2);
  const out = [];
  let pageToken = '';
  while (out.length < UPLOADS_MAX_PER_CHANNEL) {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    Object.entries({ key, part: 'snippet,status', playlistId, maxResults: '50', pageToken }).forEach(([k, v]) => v && url.searchParams.set(k, v));
    let json;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    } catch (e) {
      console.warn(`uploads ${channel.channel_name}: 실패 (${e.message})`);
      break;
    }
    for (const it of json.items || []) {
      const id = it.snippet?.resourceId?.videoId;
      if (!id || it.status?.privacyStatus !== 'public') continue;
      out.push({
        id, title: unesc(it.snippet.title), channel: channel.channel_name, channelId: channel.channel_id,
        publishedAt: (it.snippet.publishedAt || '').slice(0, 10), views: 0,
        thumb: it.snippet.thumbnails?.high?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        description: (it.snippet.description || '').slice(0, 300), live: false, source: 'uploads',
      });
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  console.log(`uploads ${channel.channel_name}: ${out.length}`);
  return out;
}

// 빈 필터부터 채운다. 지난 결과에서 영상이 적은 (분류 × 도구) 조합을 검색어로 만든다.
const GAP_QUERIES = {
  dessert: ['디저트 레시피', '노오븐 디저트', '전자레인지 디저트'],
  drinking_food: ['맥주 안주 간단요리', '소주 안주 레시피', '야식 레시피'],
  snack: ['간식 만들기', '에어프라이어 간식'],
  healthy: ['다이어트 레시피', '저칼로리 한 끼', '샐러드 레시피'],
  guest: ['손님상 요리', '주말 요리 특별한', '명절 요리 레시피'],
  fridge_clear: ['냉장고 털이 요리', '남은 재료 요리', '자투리 채소 요리'],
  side_dish: ['밑반찬 레시피', '반찬 만들기 초간단'],
  meal: ['한 끼 요리 간단', '자취 요리 10분'],
};
const EQUIPMENT_QUERIES = ['전자레인지 요리', '에어프라이어 요리', '오븐 요리', '불 없이 만드는 요리', '냄비 하나 요리', '프라이팬 하나 요리'];

// 검색어는 단순 「요리」가 아니라 조합으로: 「김치볶음밥 레시피」「계란 10분 요리」「전자레인지 디저트」「맥주 안주 간단요리」.
function searchQueries(day, prevVideos) {
  // 1) 빈 곳부터: 지난 결과에서 승인 영상이 20개 미만인 분류의 검색어, 도구 검색어.
  const occCount = {};
  for (const v of prevVideos) if (v.review?.status === 'approved') for (const o of v.tags?.occasion ?? []) occCount[o] = (occCount[o] || 0) + 1;
  const gap = Object.entries(GAP_QUERIES).filter(([o]) => (occCount[o] || 0) < 20).flatMap(([, qs]) => qs);
  // 2) 그다음 레시피 이름·재료로 돌아가며.
  const recipeQ = RECIPE_NAMES.slice(0, 400).map((r) => `${r.name} 레시피`);
  const ingQ = TAGGABLE.filter((i) => ['채소', '육류', '수산물', '유제품·달걀', '두부·콩'].includes(i.cat)).map((i) => `${i.name} 10분 요리`);
  const pool = [...recipeQ, ...ingQ];
  const start = (day * API_SEARCHES_PER_RUN) % pool.length;
  const rotating = Array.from({ length: API_SEARCHES_PER_RUN }, (_, k) => pool[(start + k) % pool.length]);
  return [...new Set([...gap, ...EQUIPMENT_QUERIES, ...rotating])].slice(0, API_SEARCHES_PER_RUN);
}
async function fetchApi(key, prevVideos) {
  const found = new Map();
  // 업로드 전체(싸다) 먼저.
  for (const ch of channels) for (const v of await fetchUploads(key, ch)) found.set(v.id, v);
  const since = new Date(Date.now() - 365 * 86400000).toISOString();
  for (const q of searchQueries(Math.floor(Date.now() / 86400000), prevVideos)) {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    Object.entries({
      key, part: 'snippet', type: 'video', q, regionCode: 'KR', relevanceLanguage: 'ko', safeSearch: 'strict',
      videoEmbeddable: 'true', videoDuration: 'any', order: 'relevance', publishedAfter: since, maxResults: '10',
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
      for (const it of json.items || []) {
        found.set(it.id.videoId, {
          id: it.id.videoId, title: unesc(it.snippet.title), channel: it.snippet.channelTitle, channelId: it.snippet.channelId,
          publishedAt: it.snippet.publishedAt.slice(0, 10), views: 0,
          thumb: it.snippet.thumbnails?.high?.url || `https://i.ytimg.com/vi/${it.id.videoId}/hqdefault.jpg`,
          live: it.snippet.liveBroadcastContent !== 'none', source: 'api', query: q,
        });
      }
      console.log(`api  ${q}: ${json.items?.length ?? 0}`);
    } catch (e) {
      console.warn(`api  ${q}: 실패 (${e.message})`);
      if (/quota/i.test(e.message)) break;
    }
  }
  // videos.list — snippet·contentDetails·status로 검증(브리프 2).
  const ids = [...found.keys()];
  for (let i = 0; i < ids.length; i += 50) {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('key', key);
    url.searchParams.set('part', 'snippet,contentDetails,status,statistics');
    url.searchParams.set('id', ids.slice(i, i + 50).join(','));
    try {
      const json = await (await fetch(url, { signal: AbortSignal.timeout(20000) })).json();
      for (const v of json.items || []) {
        const row = found.get(v.id);
        if (!row) continue;
        row.embeddable = v.status?.embeddable === true;
        row.privacy = v.status?.privacyStatus;
        row.madeForKids = v.status?.madeForKids === true;
        row.live = v.snippet?.liveBroadcastContent !== 'none';
        row.durationSec = isoDuration(v.contentDetails?.duration); // 표시용일 뿐, 조리 시간이 아니다.
        row.views = Number(v.statistics?.viewCount || 0);
        // 좋아요·댓글(사장님 요청 2026-09-12). 채널이 숨기면 필드가 없다 → null.
        row.likes = v.statistics?.likeCount != null ? Number(v.statistics.likeCount) : null;
        row.comments = v.statistics?.commentCount != null ? Number(v.statistics.commentCount) : null;
      }
    } catch (e) {
      console.warn(`api  videos.list 실패 (${e.message})`);
    }
  }
  // 채널 구독자 수 — channels.list 50개당 1유닛. allowlist + 이번에 만난 채널 전부.
  const chIds = [...new Set([...channels.map((c) => c.channel_id), ...[...found.values()].map((v) => v.channelId)])];
  for (let i = 0; i < chIds.length; i += 50) {
    const url = new URL('https://www.googleapis.com/youtube/v3/channels');
    url.searchParams.set('key', key);
    url.searchParams.set('part', 'statistics');
    url.searchParams.set('id', chIds.slice(i, i + 50).join(','));
    try {
      const json = await (await fetch(url, { signal: AbortSignal.timeout(20000) })).json();
      for (const ch of json.items || []) {
        const n = ch.statistics?.hiddenSubscriberCount ? null : Number(ch.statistics?.subscriberCount ?? 0);
        subscribers[ch.id] = n;
      }
    } catch (e) {
      console.warn(`api  channels.list 실패 (${e.message})`);
    }
  }
  // allowlist 밖 채널의 검색 결과는 바로 노출하지 않는다 → needs_review로 내려간다(아래 judge 뒤).
  return [...found.values()];
}
const subscribers = {}; // channelId → 구독자 수(이번 실행에서 받은 것)
function isoDuration(s) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || '');
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

// ── 합치기 ─────────────────────────────────────────────────────────
const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')).videos || [] : [];
const byId = new Map(prev.map((v) => [v.id, v]));
const allow = new Set(channels.map((c) => c.channel_id));
const disabled = new Set(JSON.parse(readFileSync(CHANNELS, 'utf8')).filter((c) => !c.enabled).map((c) => c.channel_id));
const priority = Object.fromEntries(channels.map((c) => [c.channel_id, c.priority]));

const rss = (await Promise.all(channels.map(fetchRss))).flat();
const api = process.env.YOUTUBE_API_KEY ? await fetchApi(process.env.YOUTUBE_API_KEY, prev) : [];
if (!process.env.YOUTUBE_API_KEY) console.log('api  건너뜀 (YOUTUBE_API_KEY 없음 — MVP 범위 밖)');

const now = new Date().toISOString();
const refreshDue = new Date(Date.now() + REFRESH_DAYS * 86400000).toISOString();
for (const v of [...rss, ...api]) {
  const old = byId.get(v.id);
  byId.set(v.id, { ...old, ...v, views: Math.max(old?.views ?? 0, v.views), fetchedAt: now, refreshDueAt: refreshDue });
}

const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
const counts = { approved: 0, needs_review: 0, excluded: 0 };
const videos = [...byId.values()]
  .filter((v) => v.publishedAt >= cutoff)
  .map((v) => {
    const dish = dishOf(v);
    // 제목 + 요리 이름 + 설명의 재료 구간에서 찾는다. 제목만으로는 낚시 제목 영상의 재료를 못 잡는다.
    // 제목 + 요리 이름 + 설명의 재료 구간 + (없으면) 설명 앞부분. 제목만으로는 낚시 제목 영상의 재료를 못 잡고,
    // 「감자탕」처럼 요리 이름 속 글자(감자)만 잡히면 반쪽짜리가 된다 — 설명의 「깻잎이랑 들깨가루」까지 본다.
    const ingText = ingredientText(v);
    const ingredientsFound = tagIngredients([v.title, dish ?? '', ingText || (v.description || '').slice(0, 300)].join(' '));
    let { status, reason } = judge({ ...v, ingredients: ingredientsFound });
    // allowlist 밖 채널(API 검색 결과)은 승인해도 사람이 한 번 본다.
    if (status === 'approved' && !allow.has(v.channelId)) {
      status = 'needs_review';
      reason = 'outside_allowlist';
    }
    // 🔴 신뢰 채널은 반대로 너그럽게: 제목에 단서가 없어도(「대박!! 저만 이런 거 처음 보나요?」) 레시피 채널의
    //    영상은 레시피다. 쇼츠도 마찬가지(쿠킹트리 쇼츠 = 레시피 쇼츠, 검수 1차 확인). 광고·먹방·맛집·밈 표시는 그대로 대기.
    //    실측(2026-09-12): 62채널 상태 7,397 중 unclear_title 2,193 · shorts 442가 숨어 있었다.
    if (status === 'needs_review' && allow.has(v.channelId) && (reason === 'unclear_title' || reason === 'shorts')) {
      status = 'approved';
      reason = reason === 'shorts' ? 'allowlist_shorts' : 'allowlist_default';
    }
    const auto = tagAll([v.title, dish ?? ''].join(' '));
    // 채널 성격(category_hint)을 기본 태그로. 「렌지쉐프」 영상은 제목에 전자레인지가 없어도 전자레인지 요리다.
    // 자동 태그가 비어 있을 때만 — 제목이 말한 게 채널 성격보다 구체적이다.
    const hint = channels.find((c) => c.channel_id === v.channelId)?.category_hint;
    if (hint) {
      if (['microwave', 'air_fryer', 'pan', 'pot', 'oven', 'no_heat'].includes(hint) && auto.equipment.length === 0) auto.equipment = [hint];
      if (['meal', 'side_dish', 'snack', 'dessert', 'drinking_food', 'healthy', 'guest', 'fridge_clear'].includes(hint) && auto.occasion.length === 0) auto.occasion = [hint];
    }
    const recipeId = matchRecipe([v.title, dish ?? ''].join(' '));
    const channelMinutes = channelCookMinutes(v);
    const row = {
      ...v,
      subscribers: subscribers[v.channelId] ?? v.subscribers ?? null,
      dish,
      ingredients: ingredientsFound,
      recipeId,
      // 🔴 조리 시간은 API 값이 아니다. 레시피 DB에도 없다(⛔). 채널이 설명에 적은 값(출처 'channel')만
      //    받고, 아니면 null — 검수에서 사람이 적는다.
      actualCookMinutes: channelMinutes,
      cookTimeSource: channelMinutes != null ? 'claim' : null,
      tags: auto,
      channelPriority: priority[v.channelId] ?? 3,
      review: { status, reason },
    };
    // 검수 오버레이: 사람이 정한 값이 자동 판정을 이긴다.
    const r = reviews[v.id];
    if (r) {
      if (r.status) row.review = { status: r.status, reason: r.reason ?? 'manual' };
      if (r.recipeId !== undefined) row.recipeId = r.recipeId;
      if (r.actualCookMinutes !== undefined) {
        row.actualCookMinutes = r.actualCookMinutes;
        row.cookTimeSource = r.actualCookMinutes == null ? null : 'review';
      }
      if (r.dish !== undefined) row.dish = r.dish;
      if (r.ingredients) row.ingredients = r.ingredients;
      if (r.tags) row.tags = { ...row.tags, ...r.tags };
    }
    // 한글 없는 제목은 사람이 승인했더라도 뺀다 — 1·2차 검수 때는 이 규칙이 없었다.
    if (!/[가-힣]/.test(v.title)) row.review = { status: 'excluded', reason: 'non_korean_title' };
    // 꺼진 채널(channels.json enabled:false)의 영상은 상태에 남아 있어도 뺀다 — 전엔 예전에 받아둔 것이 검수 승인으로
    // 그대로 실렸다(2026-09-14 실측: 4채널 끄고도 21건 남음).
    if (disabled.has(v.channelId)) row.review = { status: 'excluded', reason: 'channel_disabled' };
    counts[row.review.status] += 1;
    return row;
  })
  .sort((a, b) => b.views - a.views)
  .slice(0, MAX_VIDEOS);

// 전체 상태(다음 실행의 합치기 기준). 설명 포함.
writeFileSync(STATE, JSON.stringify({ generatedAt: now, videos }));
// 원격 피드: 승인분만, 앱이 읽는 칸만(설명·검색어·판정 이유 제외). 용량이 곧 사용자 데이터 요금이다.
// 채널당 상한은 **앱 번들에만**(상태는 전부 남긴다 — 다음 실행의 합치기 기준이고 검수 대상). 조회수순이라
// 큰 채널이 독식하니 채널당 MAX_PER_CHANNEL, 전체 MAX_APP_VIDEOS.
const forApp = videos
  .filter((v) => v.review.status === 'approved')
  .filter((() => {
    const seen = {};
    return (v) => (seen[v.channelId] = (seen[v.channelId] || 0) + 1) <= MAX_PER_CHANNEL;
  })())
  .slice(0, MAX_APP_VIDEOS)
  .map(({ description: _d, query: _q, privacy: _p, live: _l, ...v }) => v);
writeFileSync(
  OUT,
  JSON.stringify({
    version: 1,
    generatedAt: now,
    // 앱이 video_channels도 여기서 받는다(구독자·priority·hint).
    channels: channels.map((c) => ({ channel_id: c.channel_id, channel_name: c.channel_name, enabled: c.enabled, priority: c.priority, category_hint: c.category_hint, last_synced_at: c.last_synced_at, subscribers: c.subscribers ?? null })),
    count: forApp.length,
    videos: forApp,
  }),
);
writeFileSync(
  new URL('review-queue.json', HERE),
  JSON.stringify(
    videos
      .filter((v) => v.review.status !== 'approved' || v.recipeId == null)
      .map((v) => ({ id: v.id, status: v.review.status, reason: v.review.reason, channel: v.channel, title: v.title, dish: v.dish, description: v.description ?? '', ingredients: v.ingredients, recipeId: v.recipeId, actualCookMinutes: v.actualCookMinutes, tags: v.tags })),
    null,
    2,
  ),
);
writeFileSync(
  CHANNELS,
  JSON.stringify(
    JSON.parse(readFileSync(CHANNELS, 'utf8')).map((c) => ({
      ...c,
      last_synced_at: channels.find((x) => x.channel_id === c.channel_id)?.last_synced_at ?? c.last_synced_at,
      subscribers: subscribers[c.channel_id] ?? c.subscribers ?? null,
    })),
    null,
    2,
  ) + '\n',
);
console.log(`→ 상태 ${videos.length}개 · 피드 ${forApp.length}개 · approved ${counts.approved} · needs_review ${counts.needs_review} · excluded ${counts.excluded} · 레시피 연결 ${videos.filter((v) => v.recipeId).length} · 요리 이름 ${videos.filter((v) => v.dish).length} · 조리 시간 ${videos.filter((v) => v.actualCookMinutes != null).length}`);
