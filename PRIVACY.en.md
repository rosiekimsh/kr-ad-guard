# Privacy Policy — KR Ad Guard (도박배너 차단기)

Effective: 2026-11-24 · [한국어](PRIVACY.md)

## Summary
- This extension has **no operator server**. The developer collects **no data**.
- Browsing activity, page content, images and the learned list are processed and stored **only inside your own browser**.
- No analytics, advertising or tracking tools. It does not download or run remote code.

## What it does
It reads banner images on your device with OCR (Tesseract) and hides them if they look like illegal gambling or similar ads.

## Data stored on your device (all local)
| Data | Content | Where |
|---|---|---|
| Analysis cache | image URL → score and part of the recognized text (up to 3,000 entries) | `chrome.storage.local` |
| Learned list | **perceptual hashes** (64-bit numbers) of banners: manual removal, right-click report, auto-learning, and hashes you marked as legitimate | `chrome.storage.local` |
| Removed addresses | image/frame addresses (without query strings) so the same image can be hidden next time | `chrome.storage.local` |
| Statistics | cumulative hidden count | `chrome.storage.local` |
| Settings | on/off, sensitivity, test mode, **domains where you turned it off** | `chrome.storage.sync` |

- Image files themselves are not stored (only hashes).
- If Chrome Sync is on, **Chrome syncs `chrome.storage.sync` settings through your Google account**. The developer cannot access them.
- You can wipe learned/allow/cache data with **Reset learned list** in the popup; uninstalling the extension deletes all local data.

## Network
- The extension **sends no data to the developer or any third party.**
- To analyze an image, it **re-fetches the banner image that the page already displays, from the same image URL** (without cookies, preferring the browser cache). This looks like an ordinary image request to that ad server.

## Why each permission is needed
| Permission | Reason |
|---|---|
| All sites (`<all_urls>`, content scripts) | Find and hide banners on any site and load images for analysis |
| `storage` | Save settings, learned list and cache on your device |
| `offscreen` | Run the OCR engine (WebAssembly) in a background document |
| `webNavigation` | Find ad iframes, hide them from the parent page, and sum hidden counts per frame |
| `contextMenus` | The right-click "Report as gambling banner" menu on images |

## Test report
"Copy test report" in the popup creates text on your clipboard only when you click it (domains partly masked like `ab***.com`) and sends it nowhere automatically. You decide whether and where to share it.

## Contact
Please use GitHub Issues. Do not post images or real URLs.
