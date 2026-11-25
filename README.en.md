# KR Ad Guard (도박배너 차단기)

[한국어](README.md) · **English**

A Chrome extension that automatically finds and hides the **illegal gambling, adult and unlicensed-medicine banner ads** that flood many Korean websites.
It reads the text inside banner images with **on-device OCR**, so it can catch banners that rotate their URLs and slip past ordinary ad-blocking filter lists.

🔒 **No server · no account · no tracking** — images and browsing history never leave your computer.
🧠 **Gets better as you use it** — remove a missed banner once and it stays gone.

> 💡 If a banner is missed or a legitimate image gets hidden, press **Restore this page** or use **Remove a banner manually** in the popup.

> The detection vocabulary is Korean (e.g. first-deposit bonus terms, Korean brand-style phrases), so it is designed for **Korean-language sites**.

## Install (1 minute, Chrome)
1. Download `kr-ad-guard-v0.6.0.zip` from [**Releases**](../../releases/latest) and **unzip** it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder. Done!

> **Do not delete** the unzipped folder (the extension would disappear). To update, unzip the new version **into the same folder** and click the reload (↻) button on `chrome://extensions` — your learned data is kept.
> Tested on Chrome 109+. Other Chromium-based browsers have not been tested.

## How to use
| I want to… | Do this |
|---|---|
| See how many were hidden | Number badge on the toolbar icon |
| **Remove a banner it missed** | Popup → **🖱 Remove banner manually**, then click the banner (Esc to cancel). Works on images, CSS background images, box-shaped ads and iframes. It is **hidden automatically on later visits** |
| Report from an image | Right-click an image → **Report as gambling banner** (Korean menu label) |
| Fix a wrong hide | Popup → **Restore this page** (that banner will not be blocked again) |
| Block more / less | Popup → Sensitivity: Conservative / Balanced / Aggressive |
| Turn off on one site | Popup → disable "Use on this site" |
| See what would be hidden | Popup → Test mode (red outline instead of hiding) |
| Move or reset what it learned | Popup → Export / Import / Reset learned list |

*(The popup UI is currently in Korean.)*

## How it works
1. Collects candidate banners: wide images inside links (including background images and iframes).
2. First score from link/file-name patterns, groups of same-size banners, and page context (pages that promote gambling sites).
3. Reads each candidate image **on your device** with Korean OCR (Tesseract) and scores keywords with **jamo-level fuzzy matching**, which tolerates OCR misreads.
4. Hides the banner if the score passes the threshold. Confirmed banners are remembered as a **perceptual hash** so the next copy is blocked instantly, without OCR.

Legal Korean lotteries/sports-betting and cryptocurrency-info banners are down-weighted to reduce false positives.

## Privacy
**There is no operator server.** Images, browsing history and the learned list are processed and stored only on your device and are never transmitted. No ads, analytics, tracking or remote code. Details: [PRIVACY.en.md](PRIVACY.en.md)

## Accuracy (honest numbers)
Measured on a **small sample (27 banners + synthetic pages)** collected by the developer; real-world results will differ.
- 17 of 20 banners blocked on ordinary pages, 0 false positives on legitimate images
- 8/8 iframe ads blocked, 0 false positives on 3 legitimate images
- Banners with very decorative fonts, distorted text, or only a brand name may be missed → use **manual removal**

## Known limitations
- Ads drawn on canvas/video and images with extreme aspect ratios are not auto-detected (manual removal works for images, backgrounds and iframes)
- If hotlink protection prevents fetching an image, it cannot be analyzed
- Heavily cropped copies of a learned image get a different hash and are not recognized
- No Safari or mobile version yet

## FAQ
**It hid a legitimate image.** Popup → *Restore this page*. The image goes on an allow-list and won't be blocked again. If it keeps happening, please [open an issue](../../issues/new/choose).
**Why does it need access to all sites?** To find banners and analyze images on any site. Nothing leaves your device ([why each permission](PRIVACY.en.md)).
**I moved the folder and lost what it learned.** For unpacked extensions, a different folder path is a different extension. *Export* the learned list before moving.

## Reporting & contributing
On a page with many ads: popup → **Copy test report** → paste into an [issue](../../issues/new/choose) (domains are partly masked like `ab***.com`). **Do not post real ad images or site URLs.** See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development
```bash
npm test                 # unit tests for scoring & hashing (Node 18+, no dependencies)
./scripts/package.sh     # build the release zip into dist/
```
`extension/scoring.js` (keywords & scoring) · `content.js` (detection, hiding, manual removal) · `offscreen.js` (OCR & hashing) · `background.js` (relay, cache, learned list) · `phash.js` (perceptual hash) · `popup.*` (settings UI) · `lib/` (Tesseract.js and the Korean model)

## License
MIT ([LICENSE](LICENSE)). Bundled open-source components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
