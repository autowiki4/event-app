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
      { title: "Finish the shared run", body: "Release the Finish booth button so attendees can save this visit and return to their timed route." },
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
    title: "The Heaven Booth",
    icon: "☁️",
    blurb: "A simple, leader-paced sequence through four pictures and four Matthew 13 passages. ~20 min",
    mode: "self",
    page: "booth-story.html",
    staffPage: "story.html",
    leaderSteps: [
      { title: "The Heaven Booth", body: "Keep the opening screen on the booth name until you are ready to begin." },
      { title: "Picture 1", body: "Show the mustard seed and tree picture and ask: What do you see in this picture?" },
      { title: "Picture 2", body: "Show the yeast and dough picture and ask: What do you see in this picture?" },
      { title: "Picture 3", body: "Show the hidden treasure picture and ask: What do you see in this picture?" },
      { title: "Picture 4", body: "Show the fishing net picture and ask: What do you see in this picture?" },
      { title: "Are they related?", body: "Ask whether all four pictures are related." },
      { title: "They actually are", body: "Reveal that the pictures are related and ask what they describe." },
      { title: "The Kingdom of Heaven", body: "Show the four pictures together and reveal the shared subject." },
      { title: "Matthew 13:31–32", body: "Show the mustard seed picture with the complete NIV passage." },
      { title: "Matthew 13:33", body: "Show the yeast and dough picture with the complete NIV passage." },
      { title: "Matthew 13:44", body: "Show the hidden treasure picture with the complete NIV passage." },
      { title: "Matthew 13:47–48", body: "Show the fishing net picture with the complete NIV passage." },
      { title: "Thank you", body: "Show the final Thank you screen and release the attendee Finish booth button." },
    ],
  },
  {
    id: "art",
    title: "Art Therapy Table",
    icon: "🖌️",
    blurb: "Follow a leader-paced heart-and-mind reflection, two Bible passages, and a guided creative activity. ~20 min",
    mode: "kiosk",
    page: "booth-art.html",
    staffPage: "art.html",
    kioskPage: "../phase2-booths/kiosk-art.html",
    leaderSteps: [
      { title: "What is art therapy?", body: "Publish Slide 1 only when the room is ready, including the distinction between clinical art therapy and today's guided reflection activity." },
      { title: "Why is it important?", body: "Publish Slide 2, then reveal the supplied heart-and-mind visual as a separate leader-controlled step." },
      { title: "What does the Bible say?", body: "Ask the heart question, then reveal Proverbs 4:23 and Philippians 4:7 one at a time on the same shared slide." },
      { title: "Now it’s your turn", body: "Open the hands-on creative activity and guide the room with the physical art materials. The app collects no artwork or reflection text." },
      { title: "I’m finished—now what?", body: "Publish the closing reflection, give the room a final thought, then release Done for everyone together." },
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
      { title: "Finish the shared run", body: "Release the Finish booth button so guests save this visit and return to their timed route." },
    ],
  },
];

/* ---- Timed wristband experience ----
 * These timestamps include Nashville's UTC offset on the event date. That
 * keeps every device on the same two shared 20-minute windows, regardless
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
  blue: ["heaven", "trivia"],
  red: ["trivia", "heaven"],
  orange: ["art", "story"],
  green: ["newsong", "art"],
  yellow: ["story", "newsong"],
});

// The wristband route remains two scheduled booth rotations. The optional
// extra booth is deliberately separate so it never becomes a third automatic
// wristband stop, while staff/activity APIs can still address it as Session 3.
const BOOTH_SESSIONS = Object.freeze([
  Object.freeze({ id: "session-1", number: 1, startsAt: "2026-07-18T15:35:00-05:00", endsAt: "2026-07-18T15:55:00-05:00", label: "3:35–3:55 PM" }),
  Object.freeze({ id: "session-2", number: 2, startsAt: "2026-07-18T15:55:00-05:00", endsAt: "2026-07-18T16:15:00-05:00", label: "3:55–4:15 PM" }),
]);
const EXTRA_BOOTH_SESSION = Object.freeze({
  id: "session-3",
  number: 3,
  kind: "extra",
  startsAt: "2026-07-18T16:50:00-05:00",
  endsAt: "2026-07-18T17:10:00-05:00",
  label: "4:50–5:10 PM",
});
const ALL_BOOTH_SESSIONS = Object.freeze([...BOOTH_SESSIONS, EXTRA_BOOTH_SESSION]);

const MAIN_MESSAGE_STARTS_AT = "2026-07-18T16:15:00-05:00";
const MAIN_MESSAGE_ENDS_AT = "2026-07-18T16:50:00-05:00";
const EVENT_ENDS_AT = "2026-07-18T17:10:00-05:00";

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

/* ---- Art Therapy Table ---- */
const ART_PROMPTS = [
  "Draw what peace feels like to you right now.",
  "Draw a moment from this year you want to remember.",
  "Draw what you'd want to let go of today.",
  "Draw a picture of hope.",
  "Draw something you're thankful for.",
];

/* ---- The New Song in Nashville ---- */
const SONG_LIST = [
  "He Turned It",
  "Victory",
  "Brighter Day",
  "Praise - elevation worship",
  "I thank God - maverick city",
  "Amen- Madison Ryann Ward",
  "Quick - Caleb Gordon",
  "Goodbye Yesterday - elevation rhythm",
  "He called me",
  "247",
  "Elohim",
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
