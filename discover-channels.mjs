// 요리 채널 후보 찾기 — YouTube Data API search.list(type=channel) + channels.list(통계).
//
//   YOUTUBE_API_KEY=… node feed/discover-channels.mjs   → feed/channel-candidates.json
//
// 검색 하나 100유닛 × 32개 = 3,200유닛 + channels.list(50개당 1유닛). 하루 한도 10,000 안.
// 결과는 **후보**다. 사람이 걸러(먹방·브이로그·쇼핑 제외) videoChannels.json에 넣는다.
import { readFileSync, writeFileSync } from 'node:fs';

const key = process.env.YOUTUBE_API_KEY;
if (!key) {
  console.error('YOUTUBE_API_KEY가 없습니다.');
  process.exit(1);
}
const HERE = new URL('./', import.meta.url);
const existing = new Set(JSON.parse(readFileSync(new URL('channels.json', import.meta.url), 'utf8')).map((c) => c.channel_id));

// 2차 검색어(2026-09-13). 1차(요리 레시피·집밥·자취…)와 겹치지 않게 재료·요리·상황으로.
const QUERIES = [
  '두부 요리 레시피', '계란 요리 채널', '닭가슴살 요리', '돼지고기 요리 레시피', '해산물 요리 채널', '버섯 요리',
  '김치찌개 된장찌개 레시피', '볶음밥 레시피', '파스타 만들기', '국수 면 요리', '떡볶이 만들기', '김밥 만들기',
  '도시락 반찬', '아이 간식 만들기', '노오븐 디저트', '홈카페 음료', '에어프라이어 레시피', '전자레인지 레시피',
  '원팬 요리', '초간단 야식', '캠핑 요리', '한식 셰프 채널', '중식 요리 레시피', '일식 요리 레시피',
  '양식 레시피', '비건 채식 요리', '저탄수 식단', '당뇨 식단 레시피', '이유식 유아식', '명절 음식 만들기',
  '반찬가게 레시피', '시골 집밥',
];

async function api(path, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  Object.entries({ key, ...params }).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

const found = new Map();
for (const q of QUERIES) {
  try {
    const json = await api('search', { part: 'snippet', type: 'channel', q, regionCode: 'KR', relevanceLanguage: 'ko', maxResults: '50' });
    for (const it of json.items || []) {
      const id = it.snippet.channelId;
      const cur = found.get(id) || { id, title: it.snippet.title, description: it.snippet.description || '', hits: 0, queries: [] };
      cur.hits += 1;
      cur.queries.push(q);
      found.set(id, cur);
    }
    console.log(`search ${q}: ${json.items?.length ?? 0}`);
  } catch (e) {
    console.warn(`search ${q}: 실패 (${e.message})`);
    if (/quota/i.test(e.message)) break;
  }
}

const ids = [...found.keys()];
for (let i = 0; i < ids.length; i += 50) {
  try {
    const json = await api('channels', { part: 'snippet,statistics', id: ids.slice(i, i + 50).join(',') });
    for (const ch of json.items || []) {
      const c = found.get(ch.id);
      if (!c) continue;
      c.subscribers = ch.statistics?.hiddenSubscriberCount ? null : Number(ch.statistics?.subscriberCount ?? 0);
      c.videoCount = Number(ch.statistics?.videoCount ?? 0);
      c.views = Number(ch.statistics?.viewCount ?? 0);
      c.country = ch.snippet?.country ?? null;
      c.description = (ch.snippet?.description || c.description || '').slice(0, 200);
    }
  } catch (e) {
    console.warn(`channels.list 실패 (${e.message})`);
  }
}

// 1차 거르기(자동): 이미 있는 채널 제외, 영상 30개 미만 제외, 구독자 1만 미만 제외,
// 이름·설명에 먹방·브이로그·쇼핑·리뷰가 있으면 뒤로(사람이 본다).
const SUSPECT = /먹방|mukbang|브이로그|vlog|쇼핑|공동구매|리뷰|review|맛집|여행/i;
const out = [...found.values()]
  .filter((c) => !existing.has(c.id) && (c.videoCount ?? 0) >= 30 && (c.subscribers ?? 0) >= 10000)
  .map((c) => ({ ...c, suspect: SUSPECT.test(`${c.title} ${c.description}`) }))
  .sort((a, b) => Number(a.suspect) - Number(b.suspect) || b.hits - a.hits || (b.subscribers ?? 0) - (a.subscribers ?? 0));

writeFileSync(new URL('channel-candidates.json', HERE), JSON.stringify(out, null, 2));
console.log(`→ 후보 ${out.length}개 (의심 ${out.filter((c) => c.suspect).length}) → feed/channel-candidates.json`);
