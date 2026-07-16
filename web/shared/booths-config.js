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
    blurb: "Create first, then follow leader-paced Revelation, New Jerusalem, and next-step reveals. ~20 min",
    mode: "self",
    page: "booth-heaven.html",
    staffPage: "heaven.html",
    leaderSteps: [
      { title: "Welcome and draw", body: "Invite the group to draw what they think the Kingdom of Heaven looks like, then watch for their ready confirmations." },
      { title: "Reveal Revelation 21:10–11", body: "Publish the description and confetti together when the speaker is ready." },
      { title: "Show the New Jerusalem size", body: "Let attendees study the United States comparison graphic and its final question." },
      { title: "Reveal what the size means", body: "Publish the burst transition and explanation only when the speaker reaches it." },
      { title: "Preview five programs", body: "Show the Nashville Christian Collective opportunities as information only; this does not enter Phase 3." },
      { title: "Finish the shared run", body: "Release the Done button so attendees can save this visit and return to their timed route." },
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
      { title: "Art reveals what words can't", body: "Welcome the group and introduce Proverbs 4:23. · Minutes 0–3" },
      { title: "The triangle", body: "Use three points to explore how I see myself, how others see me, and how I relate to the world. · Minutes 3–6" },
      { title: "Draw your heart", body: "Give the group quiet time to create from the reflection prompts without judging their work. · Minutes 6–13" },
      { title: "Look at what you made", body: "Pause for a word or phrase about what stands out, then read Philippians 4:7. · Minutes 13–15" },
      { title: "This is just the beginning", body: "Invite an optional next-step reflection, then mark the booth complete. · Minutes 15–20" },
    ],
  },
  {
    id: "newsong",
    title: "The New Song in Nashville",
    icon: "🎵",
    blurb: "Vote together, reveal the room's winner, then discover the new song in Revelation 14:3. ~20 min",
    mode: "kiosk",
    page: "booth-newsong.html",
    staffPage: "newsong.html",
    kioskPage: "../phase2-booths/kiosk-newsong.html",
    leaderSteps: [
      { title: "Welcome the room", body: "Keep attendee screens in the cloud lobby until the speaker is ready to open voting." },
      { title: "Open the eleven-song vote", body: "Give every attendee one vote, watch the live graph, and wait until the room has had time to choose." },
      { title: "Reveal the winner", body: "Freeze the result for this run. If the vote is tied, every tied title remains visible and the canonical-order tiebreak is explained." },
      { title: "Reveal Revelation 14:3", body: "Move every screen to the new-song passage and its visual when the speaker reaches the lesson." },
      { title: "Finish the shared run", body: "Release the Done button so guests save this visit and return to their timed route." },
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

/* ---- Can You Draw Heaven? (Revelation 21) ---- */
const HEAVEN_DETAILS = [
  { id: "gates", text: "12 gates, each a single pearl" },
  { id: "streets", text: "Streets of gold, clear as glass" },
  { id: "river", text: "The river of life flowing from the throne" },
  { id: "tree", text: "The tree of life, bearing fruit every month" },
  { id: "nomore", text: "No more tears, death, or pain" },
  { id: "light", text: "No sun or moon needed — God's glory is the light" },
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

/* ---- Art Therapy Table ---- */
const ART_PROMPTS = [
  "Draw what peace feels like to you right now.",
  "Draw a moment from this year you want to remember.",
  "Draw what you'd want to let go of today.",
  "Draw a picture of hope.",
  "Draw something you're thankful for.",
];

const ART_BEATS = [
  {
    id: "intro",
    time: "0–3 min · Intro",
    text: "Art reveals what words can't.",
    verse: { ref: "Proverbs 4:23", text: "Above all else, guard your heart, for everything you do flows from it." },
  },
  {
    id: "triangle",
    time: "3–6 min · The triangle",
    text: "Three points. Three parts of you.",
    points: [
      { title: "How I see myself", sub: "Emotions & identity" },
      { title: "How others see me", sub: "The image I show" },
      { title: "How I relate to the world", sub: "Relationships & responses" },
    ],
    verse: { ref: "1 Samuel 16:7", text: "People look at the outward appearance, but the Lord looks at the heart." },
  },
  {
    id: "drawing",
    time: "6–13 min · Draw",
    text: "Draw a triangle for your heart.",
    quiet: "Quiet time to create — take it slow.",
    chips: ["What do others not see?", "What's hard to express?", "Who shaped who you are?", "What needs God's peace?"],
  },
  {
    id: "reflection",
    time: "13–15 min · Reflect",
    text: "Look at what you made.",
    prompt: "What stands out to you?",
    placeholder: "A word or phrase…",
    verse: { ref: "Philippians 4:7", text: "The peace of God, which transcends all understanding, will guard your hearts and your minds in Christ Jesus." },
  },
  {
    id: "connection",
    time: "15–20 min · What's next",
    text: "This is just the beginning.",
    prompt: "What would you want to explore more?",
    placeholder: "Optional…",
    optional: true,
  },
];

/* ---- The New Song in Nashville ---- */
const SONG_LIST = [
  "He Called Me — Eugy Official",
  "He Turned It",
  "Victory",
  "Brighter Day",
  "Praise — Elevation Worship",
  "247 — Tbabz",
  "Elohim — Sondae",
  "I Thank God — Maverick City",
  "Amen — Madison Ryann Ward",
  "Quick — Caleb Gordon",
  "Goodbye Yesterday — Elevation Rhythm",
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
