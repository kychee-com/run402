import { action, app, page, query, route } from "@wasp.sh/spec";
import { MainPage } from "./src/MainPage" with { type: "ref" };
import {
  createDreamDrop,
  emailDreamDrop,
  getDreamDrops,
  remixDreamDrop,
} from "./src/server/operations" with { type: "ref" };

export default app({
  name: "dreamdrop",
  wasp: { version: "^0.25.0" },
  title: "DreamDrop — Wasp × Run402",
  head: [
    "<link rel='icon' href='/favicon.ico' />",
    "<meta name='description' content='Drop a wild idea. Wasp and Run402 turn it into a launch-ready AI artifact.' />",
    "<meta name='theme-color' content='#11110f' />",
    "<meta property='og:title' content='DreamDrop — Wild ideas. Real infrastructure.' />",
    "<meta property='og:description' content='A full-stack Wasp × Run402 showcase.' />",
    "<meta property='og:image' content='/og.png' />",
    "<meta name='twitter:card' content='summary_large_image' />",
  ],
  spec: [
    route("RootRoute", "/", page(MainPage), { prerender: true }),
    query(getDreamDrops),
    action(createDreamDrop),
    action(remixDreamDrop),
    action(emailDreamDrop),
  ],
});
