# fridgehunter-feed

냉장고 헌터 앱의 「레시피 영상」 피드. GitHub Actions가 매일 06:00(KST) `build.mjs`를 돌려
`videos.json`을 갱신하고, 앱은 그 파일 하나를 하루 한 번 받는다.

- 유튜브 **공개 데이터**(신뢰 채널의 영상 제목·채널·썸네일 주소·조회수·태그)만 담는다. 사용자 데이터는 없다.
- 영상 자체는 담지 않는다. 앱은 유튜브 공식 임베드 플레이어로 재생한다.
- 채널 목록 `channels.json`은 사람이 고른 allowlist다. 먹방·브이로그·제품 리뷰·맛집 방문·라이브는 자동 제외되고,
  광고·협찬·쇼츠·밈 표시는 `review-queue.json`에서 사람이 본다(`reviews.json`이 판정을 덮어쓴다).
- `state.json`은 전체 수집 상태(제외·대기 포함), `videos.json`은 승인분만.

| 파일 | 역할 |
|---|---|
| `build.mjs` | 수집·검수·태그·출력 |
| `channels.json` | 신뢰 채널 allowlist(channel_id·enabled·priority·category_hint·subscribers) |
| `reviews.json` | 사람의 검수 오버레이(status·dish·recipeId·actualCookMinutes·tags) |
| `ingredients.json` / `recipe-names.json` | 앱 사전 사본 — 재료 태그·레시피 연결용 |
| `discover-channels.mjs` / `resolve-channels.mjs` | 채널 후보 검색·이름 확인(키 필요) |

secret `YOUTUBE_API_KEY`가 있으면 채널 업로드 전체(`playlistItems`, 50개당 1유닛)와 검색을 돌리고,
없으면 RSS만 돈다. 하루 사용량은 무료 한도(10,000유닛)의 절반 이하다.

영상·썸네일의 저작권은 각 채널에 있다. 제외를 원하는 채널은 이슈로 알려주면 allowlist에서 뺀다.
