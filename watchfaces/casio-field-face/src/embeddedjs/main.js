import Poco from "commodetto/Poco";

// A deliberately small first face: readable at a glance, with room for the
// phone-provided weather data that will come next.
const render = new Poco(screen);
const ink = render.makeColor(15, 22, 19);
const paper = render.makeColor(239, 235, 212);
const accent = render.makeColor(218, 105, 42);
const muted = render.makeColor(89, 98, 84);

const titleFont = new render.Font("Bitham-Black", 12);
const timeFont = new render.Font("Bitham-Black", 54);
const infoFont = new render.Font("Bitham-Black", 16);
const smallFont = new render.Font("Bitham-Black", 12);

const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function centered(text, font, y, color) {
  const x = (render.width - render.getTextWidth(text, font)) / 2;
  render.drawText(text, font, color, x, y);
}

function draw() {
  const now = new Date();
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  const date = `${days[now.getDay()]}  ${months[now.getMonth()]} ${now.getDate()}`;

  render.begin();
  render.fillRectangle(paper, 0, 0, render.width, render.height);

  // Top label and a narrow orange rule give it a Casio instrument feel.
  render.drawText("FIELD TIME", titleFont, ink, 10, 9);
  render.drawText("TIME 2", titleFont, muted, render.width - 48, 9);
  render.fillRectangle(accent, 10, 27, render.width - 20, 3);

  centered(date, infoFont, 38, muted);
  centered(`${hour}:${minute}`, timeFont, 63, ink);

  render.fillRectangle(ink, 10, 131, render.width - 20, 2);
  render.drawText("WEATHER", smallFont, muted, 10, 143);
  render.drawText("--°  SYNC NEXT", infoFont, ink, 10, 158);
  render.drawText("BATTERY", smallFont, muted, 133, 143);
  render.drawText("OK", infoFont, ink, 173, 158);

  render.drawText("TAP: DETAILS", smallFont, accent, 10, render.height - 18);
  render.end();
}

// Keep the prototype alive and simple. The face will update once per second
// until we add a low-power detail mode in the next pass.
watch.addEventListener("secondchange", draw);
draw();
