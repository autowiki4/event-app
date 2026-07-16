/* Shared booth metadata — attendee rooms, staff dashboards, and each
 * booth page all read from this one list so they can't drift out of sync.
 * Every booth has its own attendee `page` and staff page. `mode` preserves
 * the current operating model: Art and New Song also retain staff kiosks.
 */
const CONNECTOR_BOOTHS = [
  {
    id: "heaven",
    title: "Can You Draw Heaven?",
    icon: "🎨",
    blurb: "Draw what you picture from Revelation 21 — then see how close you got. ~20 min",
    mode: "self",
    page: "booth-heaven.html",
    staffPage: "heaven.html",
    leaderSteps: [
      { title: "Welcome to Draw Heaven", body: "Find a seat, pick up your materials, and get ready to imagine Revelation 21 together." },
      { title: "Listen and imagine", body: "Listen as the booth leader reads. Notice the colors, places, and feelings that come to mind." },
      { title: "Create your picture", body: "Draw what you picture when you think about heaven. There is no right or wrong way to show it." },
      { title: "Share what stood out", body: "If you would like, share one detail from your picture with the people near you." },
      { title: "Wrap up", body: "Finish your last detail, thank your group, and mark this booth complete before moving on." },
    ],
  },
  {
    id: "trivia",
    title: "Bible Bowl",
    icon: "🏆",
    blurb: "Jeopardy-style trivia — pick it up as you go, rack up points. ~20 min",
    mode: "self",
    page: "booth-trivia.html",
    staffPage: "trivia.html",
    leaderSteps: [
      { title: "Welcome to Bible Bowl", body: "Join your group, choose a team name, and get ready for the first question." },
      { title: "Round one", body: "Work together and choose your answers. Keep track of your team score." },
      { title: "Round two", body: "The questions are getting harder. Talk it through before your team answers." },
      { title: "Final question", body: "Place your final answer and wait for the booth leader to reveal the result." },
      { title: "Wrap up", body: "Celebrate your group, mark this booth complete, and get ready for your next stop." },
    ],
  },
  {
    id: "story",
    title: "The Sower, Live",
    icon: "🌾",
    blurb: "Follow Matthew 13 with prompts that pop up as the booth leader talks. ~20 min",
    mode: "self",
    page: "booth-story.html",
    staffPage: "story.html",
    leaderSteps: [
      { title: "Welcome to The Sower, Live", body: "Settle in and listen for the four places where the farmer's seed lands." },
      { title: "The path", body: "What tends to take your attention before something meaningful can sink in?" },
      { title: "Rocky ground", body: "Think about what helps a good beginning grow deeper roots." },
      { title: "Among the thorns", body: "Notice the worries or distractions that can crowd out what matters." },
      { title: "Good soil", body: "What would being good soil look like for you in this season?" },
      { title: "Wrap up", body: "Hold onto one thing that stood out, then mark this booth complete." },
    ],
  },
  {
    id: "art",
    title: "Art Therapy Table",
    icon: "🖌️",
    blurb: "Guided drawing and reflection with the booth leader. ~20 min",
    mode: "kiosk",
    page: "booth-art.html",
    staffPage: "art.html",
    kioskPage: "../phase2-booths/kiosk-art.html",
    leaderSteps: [
      { title: "Welcome and settle in", body: "Take a seat, choose your materials, and listen to the opening prompt. · Minutes 0–3" },
      { title: "Choose a starting shape", body: "Draw a triangle or another simple shape as the foundation for your picture. · Minutes 3–6" },
      { title: "Create freely", body: "Build out your drawing without judging it. Follow the booth leader's prompt. · Minutes 6–13" },
      { title: "Quiet reflection", body: "Pause and notice what your drawing brings to mind. · Minutes 13–15" },
      { title: "Connect and wrap up", body: "Share only what feels comfortable, then mark this booth complete. · Minutes 15–20" },
    ],
  },
  {
    id: "newsong",
    title: "The New Song in Nashville",
    icon: "🎵",
    blurb: "Vote on what plays next — then hear about the song only the redeemed can sing. ~20 min",
    mode: "kiosk",
    page: "booth-newsong.html",
    staffPage: "newsong.html",
    kioskPage: "../phase2-booths/kiosk-newsong.html",
    leaderSteps: [
      { title: "Welcome to New Song", body: "Join the group and listen for the idea of a song that belongs to a shared experience." },
      { title: "Listen together", body: "Listen to today's selection and notice the line or sound that stays with you." },
      { title: "Cast your vote", body: "Choose what the group should hear next when the booth leader opens voting." },
      { title: "Reflect", body: "What can a song communicate that ordinary words sometimes cannot?" },
      { title: "Wrap up", body: "See the group result, mark this booth complete, and prepare for your next stop." },
    ],
  },
];

/* ---- Timed wristband experience ----
 * These timestamps include Nashville's UTC offset on the event date. That
 * keeps every device on the same three shared 20-minute windows, regardless
 * of the attendee's phone timezone.
 */
const WRISTBAND_COLORS = [
  { id: "blue", label: "Blue", hex: "#2F6FED" },
  { id: "red", label: "Red", hex: "#D94A43" },
  { id: "orange", label: "Orange", hex: "#E88724" },
  { id: "green", label: "Green", hex: "#2F8A57" },
  { id: "yellow", label: "Yellow", hex: "#E5B72F" },
];

const WRISTBAND_ROUTES = Object.freeze({
  blue: ["heaven", "trivia", "story"],
  red: ["trivia", "heaven", "art"],
  orange: ["art", "story", "newsong"],
  green: ["newsong", "art", "heaven"],
  yellow: ["story", "newsong", "trivia"],
});

const BOOTH_SESSIONS = Object.freeze([
  { id: "session-1", number: 1, startsAt: "2026-07-18T15:10:00-05:00", endsAt: "2026-07-18T15:30:00-05:00", label: "3:10–3:30 PM" },
  { id: "session-2", number: 2, startsAt: "2026-07-18T15:30:00-05:00", endsAt: "2026-07-18T15:50:00-05:00", label: "3:30–3:50 PM" },
  { id: "session-3", number: 3, startsAt: "2026-07-18T15:50:00-05:00", endsAt: "2026-07-18T16:10:00-05:00", label: "3:50–4:10 PM" },
]);

function wristbandColorById(colorId) {
  return WRISTBAND_COLORS.find((color) => color.id === String(colorId || "").toLowerCase()) || null;
}

function boothById(boothId) {
  return CONNECTOR_BOOTHS.find((booth) => booth.id === boothId) || null;
}

function routeForWristband(colorId) {
  return WRISTBAND_ROUTES[String(colorId || "").toLowerCase()] || [];
}

function wristbandForBoothSession(boothId, sessionIndex) {
  const match = WRISTBAND_COLORS.find((color) => (
    WRISTBAND_ROUTES[color.id] && WRISTBAND_ROUTES[color.id][sessionIndex] === boothId
  ));
  return match || null;
}

/* ---- Bible Bowl trivia questions ---- */
const TRIVIA_QUESTIONS = [
  { id: "t1", category: "Genesis", points: 100, q: "On which day did God rest after creating the world?", choices: ["5th", "6th", "7th", "8th"], correct: 2 },
  { id: "t2", category: "Gospels", points: 100, q: "Which Gospel opens with “In the beginning was the Word”?", choices: ["Matthew", "Mark", "Luke", "John"], correct: 3 },
  { id: "t3", category: "Numbers", points: 200, q: "How many days and nights did it rain during the flood?", choices: ["7", "40", "100", "150"], correct: 1 },
  { id: "t4", category: "Miracles", points: 200, q: "How many loaves and fish fed the 5,000?", choices: ["5 loaves, 2 fish", "2 loaves, 5 fish", "7 loaves, 3 fish", "3 loaves, 7 fish"], correct: 0 },
  { id: "t5", category: "Kings", points: 300, q: "Which king asked God for wisdom above riches or long life?", choices: ["David", "Saul", "Solomon", "Hezekiah"], correct: 2 },
  { id: "t6", category: "Parables", points: 300, q: "In the Parable of the Sower, what does the seed represent?", choices: ["Money", "The word of God", "Faith", "The Holy Spirit"], correct: 1 },
  { id: "t7", category: "Revelation", points: 400, q: "How many gates does the New Jerusalem have in Revelation 21?", choices: ["7", "10", "12", "24"], correct: 2 },
  { id: "t8", category: "Disciples", points: 400, q: "How many disciples did Jesus choose as His closest followers?", choices: ["10", "12", "7", "70"], correct: 1 },
];

/* ---- The Sower, Live (Matthew 13) ---- */
const STORY_BEATS = [
  { id: "b1", text: "Jesus told the crowd a story about a farmer scattering seed — some fell on the path, some on rocky ground, some among thorns, and some on good soil." },
  { id: "b2", text: "Some seed never had a chance — birds snatched it up before it could even take root.", prompt: "What's one thing that tends to “snatch” your attention before God's word can sink in?", placeholder: "e.g. my phone, busyness…" },
  { id: "b3", text: "Some seed sprang up fast in shallow soil — but with no real root, it withered as soon as the sun got hot." },
  { id: "b4", text: "Some seed grew, but thorns choked it out. Jesus said this is like worry and the pull of money crowding out what God's planted in us.", prompt: "What's one “thorn” that tends to crowd things out for you?", placeholder: "e.g. stress, comparison…" },
  { id: "b5", text: "And some seed landed on good soil — and produced far more than was planted.", prompt: "What would it look like for you to be “good soil” this season?", placeholder: "Type a word or phrase…" },
  { id: "b6", text: "Jesus often taught in parables — stories that revealed truth to those who were really listening. Take a second to sit with what stood out to you today." },
];

/* ---- Art Therapy Table (kiosk) ---- */
const ART_PROMPTS = [
  "Draw what peace feels like to you right now.",
  "Draw a moment from this year you want to remember.",
  "Draw what you'd want to let go of today.",
  "Draw a picture of hope.",
  "Draw something you're thankful for.",
];

/* ---- The New Song in Nashville (kiosk) ---- */
const SONG_LIST = [
  "Great Are You Lord", "Way Maker", "Goodness of God", "Build My Life",
  "Reckless Love", "King of Kings", "Living Hope", "Graves Into Gardens",
  "Raise a Hallelujah", "The Blessing", "O Come to the Altar", "Do It Again",
];

/* ---- Phase 3 sign-up options ---- */
const FINAL_OPTIONS = [
  {
    id: "future",
    title: "Keep me posted on future events",
    desc: "Add this interest to your registration so the team can follow up.",
  },
  {
    id: "bible",
    title: "One-on-one Bible study",
    desc: "We'll point you to the right table today.",
    guide: { kicker: "Head over to", loc: "The Purpose Tent", detail: "Past the food line, look for the navy tent. Ask for a leader — they're expecting you." },
  },
  {
    id: "course",
    title: "The 8-month course",
    desc: "A deeper commitment. Find the table today to learn more.",
    guide: { kicker: "Head over to", loc: "The Growth Track Tent", detail: "Right next to registration — someone there can walk you through it." },
  },
  {
    id: "art",
    title: "Art therapy",
    desc: "A quieter way to process and create. Stop by today.",
    guide: { kicker: "Head over to", loc: "The Creative Corner", detail: "Follow the path past the food tent toward the shade tents." },
  },
  {
    id: "friend",
    title: "Help me invite a friend",
    desc: "Add a reminder to share the next event with someone you know.",
  },
];
