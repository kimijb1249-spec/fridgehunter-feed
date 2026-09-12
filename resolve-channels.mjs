// 채널 이름 → 실제 채널 ID·구독자 확인 (search.list type=channel, 이름당 100유닛).
//
//   YOUTUBE_API_KEY=… node feed/resolve-channels.mjs   → feed/resolved-channels.json
//
// 🔴 사장님이 받은 200개 목록(2026-09-12)은 절반 이상이 지어낸 채널이었다(「후추요리」「고시원자취주방요리」,
//    가짜 ID). 진짜로 보이는 이름만 추려 API로 확인한다. 결과는 후보 — 사람이 보고 videoChannels.json에 넣는다.
import { readFileSync, writeFileSync } from 'node:fs';

const key = process.env.YOUTUBE_API_KEY;
if (!key) {
  console.error('YOUTUBE_API_KEY가 없습니다.');
  process.exit(1);
}
const HERE = new URL('./', import.meta.url);
const existing = new Set(JSON.parse(readFileSync(new URL('channels.json', import.meta.url), 'utf8')).map((c) => c.channel_id));

// 목록에서 진짜로 보이는 이름 + 분류 힌트. 먹방·외국·브이로그 채널은 뺐다.
const NAMES = [
  ['매일맛나 delicious day', 'side_dish'], ['식탁일기 Table Diary', 'meal'], ['지현꿍', 'dessert'], ['1분요리왕 통키', 'side_dish'],
  ['Tasty Korea 테이스티 코리아', 'meal'], ['우리의식탁 W TABLE', 'meal'], ['애주가TV 참PD', 'drinking_food'], ['꼬마츄츄', 'snack'],
  ["J'adore 자도르", 'dessert'], ['오복하우스', 'side_dish'], ['수부해TV subuhae', 'meal'], ["it's ssay", 'meal'],
  ['고기남자', 'meal'], ['끼룩푸드 seagull food', 'meal'], ['딸을 위한 레시피', 'side_dish'], ['야미보이 Yummyboy', 'meal'],
  ['Mykoreandic', 'meal'], ['쿡톡 빛과소금', 'meal'], ['요리에 진심인 편', 'meal'], ['하뉴', 'meal'], ['푸딩 FOODING', 'dessert'],
  ['은수저', 'guest'], ['베이킹퍼니', 'dessert'], ['농심 nongshim', 'meal'], ['골드버튼', 'meal'], ['집밥요리백서', 'side_dish'],
  ['요리노트', 'meal'], ['오늘뭐먹지', 'meal'], ['요리하는남자', 'meal'], ['주방에서살다', 'meal'], ['냠뚝딱 60초 레시피', 'snack'],
  ['간단요리왕', 'meal'], ['다이어트요리', 'healthy'], ['비건요리 유리', 'healthy'], ['면요리연구소', 'meal'], ['술안주연구소', 'drinking_food'],
  ['홈술한잔', 'drinking_food'], ['자취의 정석', 'meal'], ['나혼자산다 혼밥', 'meal'], ['전자레인지요리', 'microwave'], ['에어프라이어요리', 'air_fryer'],
  ['헬스요리 고단백', 'healthy'], ['파스타마스터', 'meal'], ['밥도둑 레시피', 'side_dish'], ['볶음밥왕', 'meal'],
];

async function api(path, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  Object.entries({ key, ...params }).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

const out = [];
for (const [name, hint] of NAMES) {
  try {
    const s = await api('search', { part: 'snippet', type: 'channel', q: name, regionCode: 'KR', relevanceLanguage: 'ko', maxResults: '3' });
    const cands = (s.items || []).map((it) => ({ id: it.snippet.channelId, title: it.snippet.title, description: (it.snippet.description || '').slice(0, 120) }));
    if (cands.length === 0) {
      out.push({ query: name, hint, found: null });
      console.log(`${name}: 없음`);
      continue;
    }
    const c = await api('channels', { part: 'snippet,statistics', id: cands.map((x) => x.id).join(',') });
    const stats = Object.fromEntries((c.items || []).map((ch) => [ch.id, { subscribers: ch.statistics?.hiddenSubscriberCount ? null : Number(ch.statistics?.subscriberCount ?? 0), videos: Number(ch.statistics?.videoCount ?? 0), country: ch.snippet?.country ?? null }]));
    const enriched = cands.map((x) => ({ ...x, ...stats[x.id], already: existing.has(x.id) }));
    out.push({ query: name, hint, found: enriched });
    console.log(`${name}: ${enriched.map((x) => `${x.title}(${x.subscribers ?? '?'})`).join(' | ')}`);
  } catch (e) {
    console.warn(`${name}: 실패 (${e.message})`);
    if (/quota/i.test(e.message)) break;
  }
}
writeFileSync(new URL('resolved-channels.json', HERE), JSON.stringify(out, null, 2));
console.log(`→ ${out.length}개 확인 → feed/resolved-channels.json`);
