import Poco from "commodetto/Poco";

const render = new Poco(screen);
const red = render.makeColor(170, 0, 0);
const yellow = render.makeColor(255, 255, 0);
const black = render.makeColor(0, 0, 0);

render.begin();
render.fillRectangle(red, 0, 0, render.width, render.height);
render.fillRectangle(yellow, render.width / 4, render.height / 4,
  render.width / 2, render.height / 2);
render.fillRectangle(black, render.width / 2 - 2, 0, 4, render.height);
render.fillRectangle(black, 0, render.height / 2 - 2, render.width, 4);
render.end();
