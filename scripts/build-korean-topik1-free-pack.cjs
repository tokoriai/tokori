/**
 * Builds packs/korean-topik1-free.json.
 *
 * Unlike the Japanese N5 and German A1 packs there's no clean
 * permissively-licensed Korean→English TOPIK 1 list in the wild
 * (every candidate is either CC-BY-NC, untranslated, or scraped from
 * proprietary textbooks). So this pack is a hand-curated ~200-word
 * "TOPIK 1 essentials" set — the universal beginner Korean vocab
 * that overlaps every reputable TOPIK 1 / 한국어기초사전 list.
 * Basic-word translations like "안녕하세요 = hello" or "가다 = to go"
 * are factual, not creative — no licensing burden.
 *
 * Each entry carries Revised Romanization (the official ROK system)
 * as the `reading` so beginners who haven't learned hangul yet can
 * still drill.
 *
 * Run: `node scripts/build-korean-topik1-free-pack.cjs`
 */
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "packs", "korean-topik1-free.json");

// Each collection groups related vocab so learners can drill targeted
// decks. Words can repeat across collections (e.g. 차 appears in
// "drinks" and "transport") — that's fine; saveVocab is idempotent on
// (workspace, word).

const GREETINGS = [
  { word: "안녕", reading: "annyeong", gloss: "hi (informal)" },
  { word: "안녕하세요", reading: "annyeonghaseyo", gloss: "hello (polite)" },
  { word: "안녕히 가세요", reading: "annyeonghi gaseyo", gloss: "goodbye (to someone leaving)" },
  { word: "안녕히 계세요", reading: "annyeonghi gyeseyo", gloss: "goodbye (to someone staying)" },
  { word: "감사합니다", reading: "gamsahamnida", gloss: "thank you (formal)" },
  { word: "고맙습니다", reading: "gomapseumnida", gloss: "thank you (formal, native)" },
  { word: "미안합니다", reading: "mianhamnida", gloss: "I'm sorry (formal)" },
  { word: "죄송합니다", reading: "joesonghamnida", gloss: "I apologise (very formal)" },
  { word: "천만에요", reading: "cheonmaneyo", gloss: "you're welcome" },
  { word: "실례합니다", reading: "sillyehamnida", gloss: "excuse me" },
  { word: "잘 지내세요", reading: "jal jinaeseyo", gloss: "how are you? (polite)" },
  { word: "잘 지내요", reading: "jal jinaeyo", gloss: "I'm well" },
  { word: "만나서 반갑습니다", reading: "mannaseo bangapseumnida", gloss: "nice to meet you" },
  { word: "처음 뵙겠습니다", reading: "cheoeum boepgesseumnida", gloss: "pleased to meet you (first time)" },
  { word: "또 봐요", reading: "tto bwayo", gloss: "see you again" },
];

const NUMBERS_SINO = [
  { word: "영", reading: "yeong", gloss: "zero (Sino-Korean)" },
  { word: "공", reading: "gong", gloss: "zero (used in phone numbers)" },
  { word: "일", reading: "il", gloss: "one (Sino-Korean)" },
  { word: "이", reading: "i", gloss: "two (Sino-Korean)" },
  { word: "삼", reading: "sam", gloss: "three (Sino-Korean)" },
  { word: "사", reading: "sa", gloss: "four (Sino-Korean)" },
  { word: "오", reading: "o", gloss: "five (Sino-Korean)" },
  { word: "육", reading: "yuk", gloss: "six (Sino-Korean)" },
  { word: "칠", reading: "chil", gloss: "seven (Sino-Korean)" },
  { word: "팔", reading: "pal", gloss: "eight (Sino-Korean)" },
  { word: "구", reading: "gu", gloss: "nine (Sino-Korean)" },
  { word: "십", reading: "sip", gloss: "ten (Sino-Korean)" },
  { word: "백", reading: "baek", gloss: "hundred" },
  { word: "천", reading: "cheon", gloss: "thousand" },
  { word: "만", reading: "man", gloss: "ten thousand" },
];

const NUMBERS_NATIVE = [
  { word: "하나", reading: "hana", gloss: "one (native Korean)" },
  { word: "둘", reading: "dul", gloss: "two (native Korean)" },
  { word: "셋", reading: "set", gloss: "three (native Korean)" },
  { word: "넷", reading: "net", gloss: "four (native Korean)" },
  { word: "다섯", reading: "daseot", gloss: "five (native Korean)" },
  { word: "여섯", reading: "yeoseot", gloss: "six (native Korean)" },
  { word: "일곱", reading: "ilgop", gloss: "seven (native Korean)" },
  { word: "여덟", reading: "yeodeolp", gloss: "eight (native Korean)" },
  { word: "아홉", reading: "ahop", gloss: "nine (native Korean)" },
  { word: "열", reading: "yeol", gloss: "ten (native Korean)" },
];

const PEOPLE = [
  { word: "저", reading: "jeo", gloss: "I, me (humble)" },
  { word: "나", reading: "na", gloss: "I, me (casual)" },
  { word: "너", reading: "neo", gloss: "you (casual)" },
  { word: "우리", reading: "uri", gloss: "we, us" },
  { word: "그", reading: "geu", gloss: "he, that" },
  { word: "그녀", reading: "geunyeo", gloss: "she" },
  { word: "사람", reading: "saram", gloss: "person" },
  { word: "남자", reading: "namja", gloss: "man" },
  { word: "여자", reading: "yeoja", gloss: "woman" },
  { word: "아이", reading: "ai", gloss: "child" },
  { word: "학생", reading: "haksaeng", gloss: "student" },
  { word: "선생님", reading: "seonsaengnim", gloss: "teacher" },
  { word: "친구", reading: "chingu", gloss: "friend" },
  { word: "의사", reading: "uisa", gloss: "doctor" },
];

const FAMILY = [
  { word: "가족", reading: "gajok", gloss: "family" },
  { word: "아버지", reading: "abeoji", gloss: "father" },
  { word: "어머니", reading: "eomeoni", gloss: "mother" },
  { word: "아빠", reading: "appa", gloss: "dad" },
  { word: "엄마", reading: "eomma", gloss: "mom" },
  { word: "형", reading: "hyeong", gloss: "older brother (used by males)" },
  { word: "누나", reading: "nuna", gloss: "older sister (used by males)" },
  { word: "오빠", reading: "oppa", gloss: "older brother (used by females)" },
  { word: "언니", reading: "eonni", gloss: "older sister (used by females)" },
  { word: "동생", reading: "dongsaeng", gloss: "younger sibling" },
];

const VERBS = [
  { word: "가다", reading: "gada", gloss: "to go" },
  { word: "오다", reading: "oda", gloss: "to come" },
  { word: "먹다", reading: "meokda", gloss: "to eat" },
  { word: "마시다", reading: "masida", gloss: "to drink" },
  { word: "보다", reading: "boda", gloss: "to see, to watch" },
  { word: "듣다", reading: "deutda", gloss: "to listen, to hear" },
  { word: "읽다", reading: "ikda", gloss: "to read" },
  { word: "쓰다", reading: "sseuda", gloss: "to write, to use" },
  { word: "말하다", reading: "malhada", gloss: "to speak, to say" },
  { word: "하다", reading: "hada", gloss: "to do" },
  { word: "사다", reading: "sada", gloss: "to buy" },
  { word: "팔다", reading: "palda", gloss: "to sell" },
  { word: "좋아하다", reading: "joahada", gloss: "to like" },
  { word: "싫어하다", reading: "sireohada", gloss: "to dislike" },
  { word: "알다", reading: "alda", gloss: "to know" },
  { word: "모르다", reading: "moreuda", gloss: "to not know" },
  { word: "있다", reading: "itda", gloss: "to exist, to have" },
  { word: "없다", reading: "eopda", gloss: "to not exist, to not have" },
  { word: "살다", reading: "salda", gloss: "to live" },
  { word: "자다", reading: "jada", gloss: "to sleep" },
  { word: "일어나다", reading: "ireonada", gloss: "to wake up, to stand up" },
  { word: "만나다", reading: "mannada", gloss: "to meet" },
  { word: "기다리다", reading: "gidarida", gloss: "to wait" },
  { word: "시작하다", reading: "sijakhada", gloss: "to start" },
  { word: "끝나다", reading: "kkeutnada", gloss: "to finish, to end" },
  { word: "일하다", reading: "ilhada", gloss: "to work" },
  { word: "공부하다", reading: "gongbuhada", gloss: "to study" },
  { word: "여행하다", reading: "yeohaenghada", gloss: "to travel" },
  { word: "운동하다", reading: "undonghada", gloss: "to exercise" },
  { word: "요리하다", reading: "yorihada", gloss: "to cook" },
  { word: "씻다", reading: "ssitda", gloss: "to wash" },
  { word: "입다", reading: "ipda", gloss: "to wear" },
  { word: "만들다", reading: "mandeulda", gloss: "to make" },
  { word: "가르치다", reading: "gareuchida", gloss: "to teach" },
  { word: "배우다", reading: "baeuda", gloss: "to learn" },
];

const ADJECTIVES = [
  { word: "좋다", reading: "jota", gloss: "good" },
  { word: "나쁘다", reading: "nappeuda", gloss: "bad" },
  { word: "크다", reading: "keuda", gloss: "big" },
  { word: "작다", reading: "jakda", gloss: "small" },
  { word: "많다", reading: "manta", gloss: "many, much" },
  { word: "적다", reading: "jeokda", gloss: "few, little" },
  { word: "예쁘다", reading: "yeppeuda", gloss: "pretty" },
  { word: "비싸다", reading: "bissada", gloss: "expensive" },
  { word: "싸다", reading: "ssada", gloss: "cheap" },
  { word: "빠르다", reading: "ppareuda", gloss: "fast" },
  { word: "느리다", reading: "neurida", gloss: "slow" },
  { word: "덥다", reading: "deopda", gloss: "hot (weather)" },
  { word: "춥다", reading: "chupda", gloss: "cold (weather)" },
  { word: "맛있다", reading: "masitda", gloss: "delicious" },
  { word: "재미있다", reading: "jaemiitda", gloss: "interesting, fun" },
];

const TIME = [
  { word: "오늘", reading: "oneul", gloss: "today" },
  { word: "어제", reading: "eoje", gloss: "yesterday" },
  { word: "내일", reading: "naeil", gloss: "tomorrow" },
  { word: "지금", reading: "jigeum", gloss: "now" },
  { word: "아침", reading: "achim", gloss: "morning" },
  { word: "점심", reading: "jeomsim", gloss: "lunch, noon" },
  { word: "저녁", reading: "jeonyeok", gloss: "evening, dinner" },
  { word: "밤", reading: "bam", gloss: "night" },
  { word: "시간", reading: "sigan", gloss: "time, hour" },
  { word: "분", reading: "bun", gloss: "minute" },
  { word: "주", reading: "ju", gloss: "week" },
  { word: "월", reading: "wol", gloss: "month" },
  { word: "년", reading: "nyeon", gloss: "year" },
  { word: "봄", reading: "bom", gloss: "spring" },
  { word: "여름", reading: "yeoreum", gloss: "summer" },
  { word: "가을", reading: "gaeul", gloss: "autumn, fall" },
  { word: "겨울", reading: "gyeoul", gloss: "winter" },
];

const WEEKDAYS = [
  { word: "월요일", reading: "woryoil", gloss: "Monday" },
  { word: "화요일", reading: "hwayoil", gloss: "Tuesday" },
  { word: "수요일", reading: "suyoil", gloss: "Wednesday" },
  { word: "목요일", reading: "mogyoil", gloss: "Thursday" },
  { word: "금요일", reading: "geumyoil", gloss: "Friday" },
  { word: "토요일", reading: "toyoil", gloss: "Saturday" },
  { word: "일요일", reading: "iryoil", gloss: "Sunday" },
];

const FOOD = [
  { word: "밥", reading: "bap", gloss: "rice, meal" },
  { word: "물", reading: "mul", gloss: "water" },
  { word: "김치", reading: "gimchi", gloss: "kimchi" },
  { word: "빵", reading: "ppang", gloss: "bread" },
  { word: "과일", reading: "gwail", gloss: "fruit" },
  { word: "사과", reading: "sagwa", gloss: "apple" },
  { word: "바나나", reading: "banana", gloss: "banana" },
  { word: "고기", reading: "gogi", gloss: "meat" },
  { word: "닭고기", reading: "dakgogi", gloss: "chicken" },
  { word: "소고기", reading: "sogogi", gloss: "beef" },
  { word: "생선", reading: "saengseon", gloss: "fish (as food)" },
  { word: "우유", reading: "uyu", gloss: "milk" },
  { word: "커피", reading: "keopi", gloss: "coffee" },
  { word: "차", reading: "cha", gloss: "tea; car" },
  { word: "라면", reading: "ramyeon", gloss: "ramen, instant noodles" },
  { word: "김밥", reading: "gimbap", gloss: "gimbap (rice + filling rolled in seaweed)" },
  { word: "비빔밥", reading: "bibimbap", gloss: "bibimbap (mixed rice bowl)" },
  { word: "불고기", reading: "bulgogi", gloss: "bulgogi (grilled marinated beef)" },
  { word: "채소", reading: "chaeso", gloss: "vegetable" },
  { word: "음식", reading: "eumsik", gloss: "food" },
];

const PLACES = [
  { word: "집", reading: "jip", gloss: "home, house" },
  { word: "학교", reading: "hakgyo", gloss: "school" },
  { word: "회사", reading: "hoesa", gloss: "company, office" },
  { word: "가게", reading: "gage", gloss: "store, shop" },
  { word: "식당", reading: "sikdang", gloss: "restaurant" },
  { word: "화장실", reading: "hwajangsil", gloss: "bathroom, toilet" },
  { word: "도서관", reading: "doseogwan", gloss: "library" },
  { word: "병원", reading: "byeongwon", gloss: "hospital" },
  { word: "공항", reading: "gonghang", gloss: "airport" },
  { word: "역", reading: "yeok", gloss: "station" },
  { word: "백화점", reading: "baekhwajeom", gloss: "department store" },
  { word: "공원", reading: "gongwon", gloss: "park" },
  { word: "시장", reading: "sijang", gloss: "market" },
  { word: "카페", reading: "kape", gloss: "café" },
  { word: "호텔", reading: "hotel", gloss: "hotel" },
];

const OBJECTS = [
  { word: "책", reading: "chaek", gloss: "book" },
  { word: "컴퓨터", reading: "keompyuteo", gloss: "computer" },
  { word: "휴대폰", reading: "hyudaepon", gloss: "cell phone" },
  { word: "가방", reading: "gabang", gloss: "bag" },
  { word: "옷", reading: "ot", gloss: "clothes" },
  { word: "신발", reading: "sinbal", gloss: "shoes" },
  { word: "의자", reading: "uija", gloss: "chair" },
  { word: "책상", reading: "chaeksang", gloss: "desk" },
  { word: "창문", reading: "changmun", gloss: "window" },
  { word: "문", reading: "mun", gloss: "door" },
  { word: "자전거", reading: "jajeongeo", gloss: "bicycle" },
  { word: "기차", reading: "gicha", gloss: "train" },
  { word: "버스", reading: "beoseu", gloss: "bus" },
  { word: "비행기", reading: "bihaenggi", gloss: "airplane" },
  { word: "지하철", reading: "jihacheol", gloss: "subway" },
];

const QUESTIONS = [
  { word: "누구", reading: "nugu", gloss: "who" },
  { word: "무엇", reading: "mueot", gloss: "what" },
  { word: "어디", reading: "eodi", gloss: "where" },
  { word: "언제", reading: "eonje", gloss: "when" },
  { word: "왜", reading: "wae", gloss: "why" },
  { word: "어떻게", reading: "eotteoke", gloss: "how" },
  { word: "얼마", reading: "eolma", gloss: "how much" },
  { word: "몇", reading: "myeot", gloss: "how many" },
];

const CONNECTORS = [
  { word: "그리고", reading: "geurigo", gloss: "and" },
  { word: "하지만", reading: "hajiman", gloss: "but" },
  { word: "그래서", reading: "geuraeseo", gloss: "so, therefore" },
  { word: "또", reading: "tto", gloss: "also, again" },
  { word: "아주", reading: "aju", gloss: "very" },
  { word: "정말", reading: "jeongmal", gloss: "really" },
  { word: "같이", reading: "gachi", gloss: "together" },
  { word: "다시", reading: "dasi", gloss: "again" },
];

const COLORS = [
  { word: "빨간색", reading: "ppalgansaek", gloss: "red" },
  { word: "파란색", reading: "paransaek", gloss: "blue" },
  { word: "노란색", reading: "noransaek", gloss: "yellow" },
  { word: "검은색", reading: "geomeunsaek", gloss: "black" },
  { word: "하얀색", reading: "hayansaek", gloss: "white" },
  { word: "초록색", reading: "choroksaek", gloss: "green" },
];

const COLLECTIONS = [
  { id: "topik1-greetings", name: "Korean · Greetings & courtesy", description: "Hellos, thank-yous, sorries.", words: GREETINGS },
  { id: "topik1-numbers-sino", name: "Korean · Sino-Korean numbers", description: "Counting via the Chinese-derived system (used for dates, money, phone numbers).", words: NUMBERS_SINO },
  { id: "topik1-numbers-native", name: "Korean · Native Korean numbers", description: "Counting via the native system (used for ages, hours, things).", words: NUMBERS_NATIVE },
  { id: "topik1-people", name: "Korean · Pronouns & people", description: "I / you / we and the people around you.", words: PEOPLE },
  { id: "topik1-family", name: "Korean · Family", description: "Family terms — note older-brother words differ by speaker's gender.", words: FAMILY },
  { id: "topik1-verbs", name: "Korean · Everyday verbs", description: "The 35 verbs that show up first.", words: VERBS },
  { id: "topik1-adjectives", name: "Korean · Adjectives", description: "Korean 'descriptive verbs' — they conjugate like verbs.", words: ADJECTIVES },
  { id: "topik1-time", name: "Korean · Time", description: "Now, today, seasons, units.", words: TIME },
  { id: "topik1-weekdays", name: "Korean · Days of the week", description: "Monday through Sunday.", words: WEEKDAYS },
  { id: "topik1-food", name: "Korean · Food & drink", description: "Restaurant + grocery basics.", words: FOOD },
  { id: "topik1-places", name: "Korean · Places", description: "Home, school, shops, transport.", words: PLACES },
  { id: "topik1-objects", name: "Korean · Objects", description: "Books, bags, vehicles, furniture.", words: OBJECTS },
  { id: "topik1-questions", name: "Korean · Question words", description: "Who / what / where / when / why / how.", words: QUESTIONS },
  { id: "topik1-connectors", name: "Korean · Connectors & adverbs", description: "And, but, so, very, really.", words: CONNECTORS },
  { id: "topik1-colors", name: "Korean · Colors", description: "Six core colors.", words: COLORS },
];

// Combined "all essentials" collection — deduped on headword. The
// numeric order matches the topic ordering above so the dashboard
// renders categories in a sensible learning sequence.
const seen = new Set();
const all = [];
for (const c of COLLECTIONS) {
  for (const w of c.words) {
    if (seen.has(w.word)) continue;
    seen.add(w.word);
    all.push(w);
  }
}

const pack = {
  schema: "tokori-pack/v1",
  id: "free:korean-topik1",
  name: "Korean TOPIK 1 essentials — Free",
  language: "ko",
  description:
    `${all.length} TOPIK 1 essential Korean words organised into 15 thematic ` +
    `decks (greetings, numbers, family, verbs, time, food, places, …). ` +
    `Each entry carries Revised Romanization so absolute beginners can drill ` +
    `before learning hangul. Hand-curated against widely-used TOPIK 1 / ` +
    `한국어기초사전 vocabulary; basic-word translations are factual content, ` +
    `not subject to copyright.`,
  version: "1.0.0",
  license: "Public-domain factual content. Free for everyone.",
  collections: [
    {
      id: "topik1-all",
      name: `TOPIK 1 essentials · all ${all.length} words`,
      description: "Every word in this pack, in topic order.",
      words: all,
    },
    ...COLLECTIONS,
  ],
};

fs.writeFileSync(OUT, JSON.stringify(pack, null, 2) + "\n");
console.log(
  `Wrote ${OUT}\n  ${all.length} words · ${COLLECTIONS.length} sub-collections`,
);
