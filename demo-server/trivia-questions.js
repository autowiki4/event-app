/* Bible Bowl question bank.
 *
 * This file deliberately lives outside web/ so attendee browsers never
 * download the answer key. Public APIs expose only the active question and
 * withhold the correct answer until the booth leader reveals it.
 */
const TRIVIA_QUESTIONS = Object.freeze([
  {
    id: "t1",
    category: "Genesis",
    text: "Who built the ark?",
    choices: ["Moses", "Noah", "Abraham", "David"],
    correctIndex: 1,
  },
  {
    id: "t2",
    category: "Genesis",
    text: "How many days and nights did it rain during the flood?",
    choices: ["7", "30", "40", "100"],
    correctIndex: 2,
  },
  {
    id: "t3",
    category: "Prophets",
    text: "Who was swallowed by a great fish?",
    choices: ["Jonah", "Peter", "Elijah", "Samuel"],
    correctIndex: 0,
  },
  {
    id: "t4",
    category: "Exodus",
    text: "Who led the Israelites out of Egypt?",
    choices: ["Joseph", "Joshua", "Moses", "Aaron"],
    correctIndex: 2,
  },
  {
    id: "t5",
    category: "David",
    text: "What did David use to defeat Goliath?",
    choices: ["A spear", "A sword", "A slingshot and a stone", "A bow and arrow"],
    correctIndex: 2,
  },
  {
    id: "t6",
    category: "Gospels",
    text: "In which city was Jesus born?",
    choices: ["Nazareth", "Jerusalem", "Bethlehem", "Jericho"],
    correctIndex: 2,
  },
  {
    id: "t7",
    category: "Gospels",
    text: "Who baptized Jesus?",
    choices: ["Peter", "John the Baptist", "Andrew", "James"],
    correctIndex: 1,
  },
  {
    id: "t8",
    category: "Disciples",
    text: "How many disciples did Jesus choose?",
    choices: ["10", "11", "12", "13"],
    correctIndex: 2,
  },
  {
    id: "t9",
    category: "Gospels",
    text: "Who denied Jesus three times before the rooster crowed?",
    choices: ["Judas", "Thomas", "Peter", "John"],
    correctIndex: 2,
  },
  {
    id: "t10",
    category: "Miracles",
    text: "Which miracle involved five loaves and two fish?",
    choices: ["Walking on water", "Feeding the 5,000", "Turning water into wine", "Healing the blind man"],
    correctIndex: 1,
  },
  {
    id: "t11",
    category: "Genesis",
    text: "Who interpreted Pharaoh's dreams in Egypt?",
    choices: ["Daniel", "Joseph", "Jacob", "Isaac"],
    correctIndex: 1,
  },
  {
    id: "t12",
    category: "Old Testament",
    text: "Which Old Testament queen saved the Jewish people from destruction?",
    choices: ["Ruth", "Deborah", "Esther", "Bathsheba"],
    correctIndex: 2,
  },
  {
    id: "t13",
    category: "Exodus",
    text: "What was the name of the mountain where Moses received the Ten Commandments?",
    choices: ["Mount Carmel", "Mount Sinai", "Mount Zion", "Mount Hermon"],
    correctIndex: 1,
  },
  {
    id: "t14",
    category: "Acts",
    text: "Who was the first Christian martyr recorded in the Book of Acts?",
    choices: ["James", "Stephen", "Barnabas", "Philip"],
    correctIndex: 1,
  },
  {
    id: "t15",
    category: "Epistles",
    text: "Which book of the Bible describes the Fruit of the Spirit?",
    choices: ["Romans", "Ephesians", "Galatians", "Hebrews"],
    correctIndex: 2,
  },
].map((question) => Object.freeze({
  ...question,
  choices: Object.freeze(question.choices.slice()),
})));

module.exports = { TRIVIA_QUESTIONS };
