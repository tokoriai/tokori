/**
 * Builds packs/spanish-a1-free.json.
 *
 * No clean permissively-licensed Spanish A1 / DELE A1 word list with
 * English glosses ships on GitHub (every candidate is either CC-BY-NC,
 * Spanish-only, or derived from the Plan Curricular del Instituto
 * Cervantes which is copyrighted). So this pack is a hand-curated
 * ~200-word Spanish A1 essentials set — the universal beginner
 * vocabulary that overlaps every reputable A1 / DELE A1 reference.
 * Basic-word translations like "hola = hello" or "comer = to eat" are
 * factual content, not creative authorship.
 *
 * Run: `node scripts/build-spanish-a1-free-pack.cjs`
 */
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "packs", "spanish-a1-free.json");

const GREETINGS = [
  { word: "hola", reading: null, gloss: "hello" },
  { word: "buenos días", reading: null, gloss: "good morning" },
  { word: "buenas tardes", reading: null, gloss: "good afternoon" },
  { word: "buenas noches", reading: null, gloss: "good evening, good night" },
  { word: "adiós", reading: null, gloss: "goodbye" },
  { word: "hasta luego", reading: null, gloss: "see you later" },
  { word: "hasta mañana", reading: null, gloss: "see you tomorrow" },
  { word: "gracias", reading: null, gloss: "thank you" },
  { word: "muchas gracias", reading: null, gloss: "thank you very much" },
  { word: "de nada", reading: null, gloss: "you're welcome" },
  { word: "por favor", reading: null, gloss: "please" },
  { word: "perdón", reading: null, gloss: "sorry, excuse me" },
  { word: "lo siento", reading: null, gloss: "I'm sorry" },
  { word: "disculpe", reading: null, gloss: "excuse me (formal)" },
  { word: "¿cómo estás?", reading: null, gloss: "how are you? (informal)" },
  { word: "¿cómo está usted?", reading: null, gloss: "how are you? (formal)" },
  { word: "bien", reading: null, gloss: "well, fine" },
  { word: "mucho gusto", reading: null, gloss: "nice to meet you" },
];

const NUMBERS = [
  { word: "cero", reading: null, gloss: "zero" },
  { word: "uno", reading: null, gloss: "one" },
  { word: "dos", reading: null, gloss: "two" },
  { word: "tres", reading: null, gloss: "three" },
  { word: "cuatro", reading: null, gloss: "four" },
  { word: "cinco", reading: null, gloss: "five" },
  { word: "seis", reading: null, gloss: "six" },
  { word: "siete", reading: null, gloss: "seven" },
  { word: "ocho", reading: null, gloss: "eight" },
  { word: "nueve", reading: null, gloss: "nine" },
  { word: "diez", reading: null, gloss: "ten" },
  { word: "once", reading: null, gloss: "eleven" },
  { word: "doce", reading: null, gloss: "twelve" },
  { word: "veinte", reading: null, gloss: "twenty" },
  { word: "treinta", reading: null, gloss: "thirty" },
  { word: "cien", reading: null, gloss: "one hundred" },
  { word: "mil", reading: null, gloss: "thousand" },
];

const PEOPLE = [
  { word: "yo", reading: null, gloss: "I" },
  { word: "tú", reading: null, gloss: "you (informal)" },
  { word: "usted", reading: null, gloss: "you (formal)" },
  { word: "él", reading: null, gloss: "he" },
  { word: "ella", reading: null, gloss: "she" },
  { word: "nosotros", reading: null, gloss: "we (masculine or mixed)" },
  { word: "vosotros", reading: null, gloss: "you all (Spain, informal)" },
  { word: "ustedes", reading: null, gloss: "you all (formal / Latin America)" },
  { word: "ellos", reading: null, gloss: "they (masculine or mixed)" },
  { word: "ellas", reading: null, gloss: "they (feminine)" },
  { word: "persona", reading: null, gloss: "person" },
  { word: "hombre", reading: null, gloss: "man" },
  { word: "mujer", reading: null, gloss: "woman" },
  { word: "niño", reading: null, gloss: "boy, child" },
  { word: "niña", reading: null, gloss: "girl" },
  { word: "amigo", reading: null, gloss: "friend (male)" },
  { word: "amiga", reading: null, gloss: "friend (female)" },
  { word: "estudiante", reading: null, gloss: "student" },
  { word: "profesor", reading: null, gloss: "teacher (male)" },
  { word: "profesora", reading: null, gloss: "teacher (female)" },
  { word: "médico", reading: null, gloss: "doctor" },
];

const FAMILY = [
  { word: "familia", reading: null, gloss: "family" },
  { word: "padre", reading: null, gloss: "father" },
  { word: "madre", reading: null, gloss: "mother" },
  { word: "papá", reading: null, gloss: "dad" },
  { word: "mamá", reading: null, gloss: "mom" },
  { word: "hermano", reading: null, gloss: "brother" },
  { word: "hermana", reading: null, gloss: "sister" },
  { word: "hijo", reading: null, gloss: "son" },
  { word: "hija", reading: null, gloss: "daughter" },
  { word: "abuelo", reading: null, gloss: "grandfather" },
  { word: "abuela", reading: null, gloss: "grandmother" },
  { word: "tío", reading: null, gloss: "uncle" },
  { word: "tía", reading: null, gloss: "aunt" },
];

const VERBS = [
  { word: "ser", reading: null, gloss: "to be (permanent / identity)" },
  { word: "estar", reading: null, gloss: "to be (state / location)" },
  { word: "tener", reading: null, gloss: "to have" },
  { word: "ir", reading: null, gloss: "to go" },
  { word: "venir", reading: null, gloss: "to come" },
  { word: "hacer", reading: null, gloss: "to do, to make" },
  { word: "decir", reading: null, gloss: "to say, to tell" },
  { word: "ver", reading: null, gloss: "to see" },
  { word: "oír", reading: null, gloss: "to hear" },
  { word: "comer", reading: null, gloss: "to eat" },
  { word: "beber", reading: null, gloss: "to drink" },
  { word: "vivir", reading: null, gloss: "to live" },
  { word: "hablar", reading: null, gloss: "to speak, to talk" },
  { word: "escuchar", reading: null, gloss: "to listen" },
  { word: "leer", reading: null, gloss: "to read" },
  { word: "escribir", reading: null, gloss: "to write" },
  { word: "trabajar", reading: null, gloss: "to work" },
  { word: "estudiar", reading: null, gloss: "to study" },
  { word: "aprender", reading: null, gloss: "to learn" },
  { word: "enseñar", reading: null, gloss: "to teach" },
  { word: "saber", reading: null, gloss: "to know (a fact)" },
  { word: "conocer", reading: null, gloss: "to know (a person, place)" },
  { word: "querer", reading: null, gloss: "to want, to love" },
  { word: "poder", reading: null, gloss: "to be able to, can" },
  { word: "deber", reading: null, gloss: "must, ought to" },
  { word: "necesitar", reading: null, gloss: "to need" },
  { word: "comprar", reading: null, gloss: "to buy" },
  { word: "vender", reading: null, gloss: "to sell" },
  { word: "pagar", reading: null, gloss: "to pay" },
  { word: "gustar", reading: null, gloss: "to like, to be pleasing" },
  { word: "dar", reading: null, gloss: "to give" },
  { word: "recibir", reading: null, gloss: "to receive" },
  { word: "abrir", reading: null, gloss: "to open" },
  { word: "cerrar", reading: null, gloss: "to close" },
  { word: "entrar", reading: null, gloss: "to enter" },
  { word: "salir", reading: null, gloss: "to leave, to go out" },
  { word: "dormir", reading: null, gloss: "to sleep" },
  { word: "despertar", reading: null, gloss: "to wake up" },
  { word: "viajar", reading: null, gloss: "to travel" },
  { word: "caminar", reading: null, gloss: "to walk" },
  { word: "correr", reading: null, gloss: "to run" },
];

const ADJECTIVES = [
  { word: "bueno", reading: null, gloss: "good" },
  { word: "malo", reading: null, gloss: "bad" },
  { word: "grande", reading: null, gloss: "big, large" },
  { word: "pequeño", reading: null, gloss: "small" },
  { word: "mucho", reading: null, gloss: "much, a lot of" },
  { word: "poco", reading: null, gloss: "little, few" },
  { word: "bonito", reading: null, gloss: "pretty" },
  { word: "feo", reading: null, gloss: "ugly" },
  { word: "caro", reading: null, gloss: "expensive" },
  { word: "barato", reading: null, gloss: "cheap" },
  { word: "rápido", reading: null, gloss: "fast" },
  { word: "lento", reading: null, gloss: "slow" },
  { word: "fácil", reading: null, gloss: "easy" },
  { word: "difícil", reading: null, gloss: "difficult" },
  { word: "nuevo", reading: null, gloss: "new" },
  { word: "viejo", reading: null, gloss: "old" },
  { word: "joven", reading: null, gloss: "young" },
  { word: "frío", reading: null, gloss: "cold" },
  { word: "caliente", reading: null, gloss: "hot" },
  { word: "feliz", reading: null, gloss: "happy" },
];

const TIME = [
  { word: "hoy", reading: null, gloss: "today" },
  { word: "ayer", reading: null, gloss: "yesterday" },
  { word: "mañana", reading: null, gloss: "tomorrow, morning" },
  { word: "ahora", reading: null, gloss: "now" },
  { word: "después", reading: null, gloss: "after, later" },
  { word: "antes", reading: null, gloss: "before" },
  { word: "tarde", reading: null, gloss: "afternoon, late" },
  { word: "noche", reading: null, gloss: "night" },
  { word: "tiempo", reading: null, gloss: "time, weather" },
  { word: "hora", reading: null, gloss: "hour" },
  { word: "minuto", reading: null, gloss: "minute" },
  { word: "día", reading: null, gloss: "day" },
  { word: "semana", reading: null, gloss: "week" },
  { word: "mes", reading: null, gloss: "month" },
  { word: "año", reading: null, gloss: "year" },
];

const WEEKDAYS = [
  { word: "lunes", reading: null, gloss: "Monday" },
  { word: "martes", reading: null, gloss: "Tuesday" },
  { word: "miércoles", reading: null, gloss: "Wednesday" },
  { word: "jueves", reading: null, gloss: "Thursday" },
  { word: "viernes", reading: null, gloss: "Friday" },
  { word: "sábado", reading: null, gloss: "Saturday" },
  { word: "domingo", reading: null, gloss: "Sunday" },
];

const MONTHS = [
  { word: "enero", reading: null, gloss: "January" },
  { word: "febrero", reading: null, gloss: "February" },
  { word: "marzo", reading: null, gloss: "March" },
  { word: "abril", reading: null, gloss: "April" },
  { word: "mayo", reading: null, gloss: "May" },
  { word: "junio", reading: null, gloss: "June" },
  { word: "julio", reading: null, gloss: "July" },
  { word: "agosto", reading: null, gloss: "August" },
  { word: "septiembre", reading: null, gloss: "September" },
  { word: "octubre", reading: null, gloss: "October" },
  { word: "noviembre", reading: null, gloss: "November" },
  { word: "diciembre", reading: null, gloss: "December" },
];

const FOOD = [
  { word: "agua", reading: null, gloss: "water" },
  { word: "café", reading: null, gloss: "coffee" },
  { word: "té", reading: null, gloss: "tea" },
  { word: "leche", reading: null, gloss: "milk" },
  { word: "vino", reading: null, gloss: "wine" },
  { word: "cerveza", reading: null, gloss: "beer" },
  { word: "jugo", reading: null, gloss: "juice (Latin America)" },
  { word: "zumo", reading: null, gloss: "juice (Spain)" },
  { word: "pan", reading: null, gloss: "bread" },
  { word: "queso", reading: null, gloss: "cheese" },
  { word: "huevo", reading: null, gloss: "egg" },
  { word: "carne", reading: null, gloss: "meat" },
  { word: "pollo", reading: null, gloss: "chicken" },
  { word: "pescado", reading: null, gloss: "fish (as food)" },
  { word: "arroz", reading: null, gloss: "rice" },
  { word: "fruta", reading: null, gloss: "fruit" },
  { word: "manzana", reading: null, gloss: "apple" },
  { word: "naranja", reading: null, gloss: "orange" },
  { word: "verdura", reading: null, gloss: "vegetable" },
  { word: "comida", reading: null, gloss: "food, meal" },
  { word: "desayuno", reading: null, gloss: "breakfast" },
  { word: "almuerzo", reading: null, gloss: "lunch" },
  { word: "cena", reading: null, gloss: "dinner" },
];

const PLACES = [
  { word: "casa", reading: null, gloss: "house, home" },
  { word: "escuela", reading: null, gloss: "school" },
  { word: "universidad", reading: null, gloss: "university" },
  { word: "trabajo", reading: null, gloss: "work, job" },
  { word: "oficina", reading: null, gloss: "office" },
  { word: "tienda", reading: null, gloss: "store, shop" },
  { word: "restaurante", reading: null, gloss: "restaurant" },
  { word: "baño", reading: null, gloss: "bathroom" },
  { word: "biblioteca", reading: null, gloss: "library" },
  { word: "hospital", reading: null, gloss: "hospital" },
  { word: "aeropuerto", reading: null, gloss: "airport" },
  { word: "estación", reading: null, gloss: "station" },
  { word: "parque", reading: null, gloss: "park" },
  { word: "mercado", reading: null, gloss: "market" },
  { word: "ciudad", reading: null, gloss: "city" },
  { word: "calle", reading: null, gloss: "street" },
];

const OBJECTS = [
  { word: "libro", reading: null, gloss: "book" },
  { word: "computadora", reading: null, gloss: "computer (Latin America)" },
  { word: "ordenador", reading: null, gloss: "computer (Spain)" },
  { word: "teléfono", reading: null, gloss: "phone" },
  { word: "bolso", reading: null, gloss: "bag" },
  { word: "ropa", reading: null, gloss: "clothes" },
  { word: "zapato", reading: null, gloss: "shoe" },
  { word: "silla", reading: null, gloss: "chair" },
  { word: "mesa", reading: null, gloss: "table" },
  { word: "ventana", reading: null, gloss: "window" },
  { word: "puerta", reading: null, gloss: "door" },
  { word: "coche", reading: null, gloss: "car (Spain)" },
  { word: "carro", reading: null, gloss: "car (Latin America)" },
  { word: "bicicleta", reading: null, gloss: "bicycle" },
  { word: "autobús", reading: null, gloss: "bus" },
  { word: "tren", reading: null, gloss: "train" },
  { word: "avión", reading: null, gloss: "airplane" },
];

const QUESTIONS = [
  { word: "¿qué?", reading: null, gloss: "what?" },
  { word: "¿quién?", reading: null, gloss: "who?" },
  { word: "¿dónde?", reading: null, gloss: "where?" },
  { word: "¿cuándo?", reading: null, gloss: "when?" },
  { word: "¿por qué?", reading: null, gloss: "why?" },
  { word: "¿cómo?", reading: null, gloss: "how?" },
  { word: "¿cuánto?", reading: null, gloss: "how much?" },
  { word: "¿cuántos?", reading: null, gloss: "how many?" },
  { word: "¿cuál?", reading: null, gloss: "which?" },
];

const CONNECTORS = [
  { word: "y", reading: null, gloss: "and" },
  { word: "o", reading: null, gloss: "or" },
  { word: "pero", reading: null, gloss: "but" },
  { word: "porque", reading: null, gloss: "because" },
  { word: "también", reading: null, gloss: "also, too" },
  { word: "muy", reading: null, gloss: "very" },
  { word: "más", reading: null, gloss: "more" },
  { word: "menos", reading: null, gloss: "less" },
  { word: "sí", reading: null, gloss: "yes" },
  { word: "no", reading: null, gloss: "no, not" },
];

const COLORS = [
  { word: "rojo", reading: null, gloss: "red" },
  { word: "azul", reading: null, gloss: "blue" },
  { word: "amarillo", reading: null, gloss: "yellow" },
  { word: "verde", reading: null, gloss: "green" },
  { word: "negro", reading: null, gloss: "black" },
  { word: "blanco", reading: null, gloss: "white" },
];

const COLLECTIONS = [
  { id: "a1-greetings", name: "Spanish · Greetings & courtesy", description: "Hellos, please, gracias, sorry.", words: GREETINGS },
  { id: "a1-numbers", name: "Spanish · Numbers", description: "Zero to one thousand.", words: NUMBERS },
  { id: "a1-people", name: "Spanish · Pronouns & people", description: "I / you / they and the people who fill those slots.", words: PEOPLE },
  { id: "a1-family", name: "Spanish · Family", description: "Family terms.", words: FAMILY },
  { id: "a1-verbs", name: "Spanish · Everyday verbs", description: "The 41 verbs that show up first — ser vs estar, regular ar/er/ir families.", words: VERBS },
  { id: "a1-adjectives", name: "Spanish · Adjectives", description: "Core descriptive vocabulary.", words: ADJECTIVES },
  { id: "a1-time", name: "Spanish · Time", description: "Now, today, hours and days.", words: TIME },
  { id: "a1-weekdays", name: "Spanish · Days of the week", description: "Monday through Sunday.", words: WEEKDAYS },
  { id: "a1-months", name: "Spanish · Months", description: "January through December.", words: MONTHS },
  { id: "a1-food", name: "Spanish · Food & drink", description: "Restaurant + grocery basics, with Latin-American / Peninsular variants where they differ.", words: FOOD },
  { id: "a1-places", name: "Spanish · Places", description: "Home, school, shops, transport.", words: PLACES },
  { id: "a1-objects", name: "Spanish · Objects", description: "Books, bags, vehicles, furniture.", words: OBJECTS },
  { id: "a1-questions", name: "Spanish · Question words", description: "¿qué? ¿quién? ¿dónde? — with leading inverted marks.", words: QUESTIONS },
  { id: "a1-connectors", name: "Spanish · Connectors & basics", description: "And, but, very, sí/no.", words: CONNECTORS },
  { id: "a1-colors", name: "Spanish · Colors", description: "Six core colors.", words: COLORS },
];

// Combined "all essentials" collection — deduped on headword.
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
  id: "free:spanish-a1",
  name: "Spanish A1 essentials — Free",
  language: "es",
  description:
    `${all.length} Spanish A1 essential words organised into 15 thematic decks ` +
    `(greetings, numbers, family, verbs, time, food, places, …). Hand-curated ` +
    `against widely-used DELE A1 / CEFR A1 references; basic-word translations ` +
    `are factual content, not subject to copyright. Latin-American and ` +
    `Peninsular variants are flagged where they differ (jugo/zumo, carro/coche).`,
  version: "1.0.0",
  license: "Public-domain factual content. Free for everyone.",
  collections: [
    {
      id: "a1-all",
      name: `Spanish A1 essentials · all ${all.length} words`,
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
