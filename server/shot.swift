import Cocoa
import WebKit

/// 用法: shot <out.png> <宽> <url>
/// 把整页（不是视口）截成一张长图：加载 → 等图 → 量出实际高度 → 把窗口撑到那么高 → 截图。
/// 和 print.swift 一样用系统 WebKit（跟 Safari 同一引擎），版面与浏览器里看到的一致。
final class Shot: NSObject, WKNavigationDelegate {
    let out: String
    let width: CGFloat
    let web: WKWebView
    var done = false

    init(out: String, width: CGFloat, url: URL) {
        self.out = out
        self.width = width
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        self.web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: 900), configuration: cfg)
        super.init()
        web.navigationDelegate = self
        web.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 图片 / 字体晚一点才稳定，等两拍再量
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
            webView.evaluateJavaScript("Math.max((document.querySelector('.snap')||document.body).scrollHeight, document.body.scrollHeight)") { v, _ in
                let h = max(200, CGFloat((v as? NSNumber)?.doubleValue ?? 900))
                webView.frame = NSRect(x: 0, y: 0, width: self.width, height: h)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
                    let cfg = WKSnapshotConfiguration()
                    cfg.rect = CGRect(x: 0, y: 0, width: self.width, height: h)
                    webView.takeSnapshot(with: cfg) { img, _ in
                        guard let img, let tiff = img.tiffRepresentation,
                              let rep = NSBitmapImageRep(data: tiff),
                              let png = rep.representation(using: .png, properties: [:]) else {
                            print("SNAPFAIL"); exit(1)
                        }
                        do {
                            try png.write(to: URL(fileURLWithPath: self.out))
                            print("ok \(Int(h))")
                            exit(0)
                        } catch {
                            print("WRITEFAIL \(error)"); exit(1)
                        }
                    }
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("LOADFAIL \(error)"); exit(1)
    }
}

let a = CommandLine.arguments
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let shot = Shot(out: a[1], width: CGFloat(Double(a[2]) ?? 794), url: URL(string: a[3])!)
app.run()
