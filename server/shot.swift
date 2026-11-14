import Cocoa
import WebKit

/**
 * 用法: shot <out> <宽> <snapWidth> <url>
 *       shot <out> <宽> <snapWidth> <url1> <url2> …      （输出是 .pdf 时每个 url 一页）
 *
 * 把整页（不是视口）截成图：加载 → 等图 → 量出实际高度 → 把窗口撑到那么高 → takeSnapshot。
 * - `snapWidth`：输出像素宽（A4 宽 794 CSS px 时给 1588 就是 2 倍、2382 约 3 倍）；0 = 按窗口宽。
 * - `out` 以 `.pdf` 结尾时，把截图**铺满一页 PDF**（页面尺寸按 CSS px 折 pt，A4 = 595.5×842.25）。
 *   这是「截图做的 PDF」：排版字体全由 WebKit 画好再定成位图，不会有矢量 PDF 在字体 / 裁切 /
 *   跨页上的幺蛾子；代价是文字不可选、文件大一点。
 *
 * 和 print.swift 一样用系统 WebKit（跟 Safari 同一引擎），版面与浏览器里看到的一致。
 */
final class Shot: NSObject, WKNavigationDelegate {
    let out: String
    let width: CGFloat
    let snapWidth: CGFloat
    let urls: [URL]
    var idx = 0
    var pages: [(img: NSImage, h: CGFloat)] = []

    lazy var web: WKWebView = {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        let v = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: 900), configuration: cfg)
        v.navigationDelegate = self
        return v
    }()

    init(out: String, width: CGFloat, snapWidth: CGFloat, urls: [URL]) {
        self.out = out
        self.width = width
        self.snapWidth = snapWidth
        self.urls = urls
        super.init()
    }

    func start() {
        loadNext()
    }

    private func loadNext() {
        if idx >= urls.count { writeOut(); return }
        web.load(URLRequest(url: urls[idx]))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 等图：轮询「图都加载完了没」，比死等 0.8 秒快得多（一块表格从 1.7s 降到 ~0.4s）
        waitImages(webView, tries: 0)
    }

    private func waitImages(_ webView: WKWebView, tries: Int) {
        let ready = "document.readyState === 'complete' && Array.from(document.images).every((im) => im.complete)"
        webView.evaluateJavaScript(ready) { v, _ in
            let done = (v as? NSNumber)?.boolValue ?? false
            if !done && tries < 25 { // 最多等 2 秒，等不到就按现在的样子拍
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
                    self.waitImages(webView, tries: tries + 1)
                }
                return
            }
            self.measureAndShot(webView)
        }
    }

    private func measureAndShot(_ webView: WKWebView) {
        webView.evaluateJavaScript("Math.max((document.querySelector('.snap')||document.body).scrollHeight, document.body.scrollHeight)") { v, _ in
            // 量不到（null / 0）才退回整屏；量到了就按内容裁，别留一大块白（版面上的小块只有几十像素高）
            let measured = (v as? NSNumber)?.doubleValue ?? 0
            let h = measured > 0 ? max(16, CGFloat(measured)) : 900
            webView.frame = NSRect(x: 0, y: 0, width: self.width, height: h)
            // 撑高窗口后让排版重排一帧再拍
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                let cfg = WKSnapshotConfiguration()
                cfg.rect = CGRect(x: 0, y: 0, width: self.width, height: h)
                if self.snapWidth > 0 { cfg.snapshotWidth = NSNumber(value: Double(self.snapWidth)) }
                webView.takeSnapshot(with: cfg) { img, _ in
                    guard let img else { print("SNAPFAIL"); exit(1) }
                    self.pages.append((img, h))
                    self.idx += 1
                    self.loadNext()
                }
            }
        }
    }

    private func writeOut() {
        guard !pages.isEmpty else { print("NOPAGE"); exit(1) }
        if out.lowercased().hasSuffix(".pdf") { writePDF() } else { writePNG() }
    }

    /// 每张截图铺满一页（页面大小 = 截图对应的 CSS 尺寸，1px = 0.75pt）
    private func writePDF() {
        let first = pages[0]
        var mediaBox = CGRect(x: 0, y: 0, width: width * 72.0 / 96.0, height: first.h * 72.0 / 96.0)
        guard let consumer = CGDataConsumer(url: URL(fileURLWithPath: out) as CFURL),
              let ctx = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else {
            print("PDFFAIL"); exit(1)
        }
        for page in pages {
            let pageH = page.h * 72.0 / 96.0
            mediaBox = CGRect(x: 0, y: 0, width: width * 72.0 / 96.0, height: pageH)
            ctx.beginPDFPage([kCGPDFContextMediaBox as String: NSValue(rect: mediaBox)] as CFDictionary)
            if let cg = page.img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                // 实测直接 draw 就是正的（先按老经验翻了一次，结果整页倒过来）
                ctx.draw(cg, in: mediaBox)
            }
            ctx.endPDFPage()
        }
        ctx.closePDF()
        print("ok pages=\(pages.count) pdf")
        exit(0)
    }

    private func writePNG() {
        let img = pages[0].img
        guard let tiff = img.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            print("SNAPFAIL"); exit(1)
        }
        do {
            try png.write(to: URL(fileURLWithPath: out))
            print("ok \(rep.pixelsWide)x\(rep.pixelsHigh)")
            exit(0)
        } catch {
            print("WRITEFAIL \(error)"); exit(1)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("LOADFAIL \(error)"); exit(1)
    }
}

let a = CommandLine.arguments
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let shot = Shot(
    out: a[1],
    width: CGFloat(Double(a[2]) ?? 794),
    snapWidth: a.count > 3 ? CGFloat(Double(a[3]) ?? 0) : 0,
    urls: a.dropFirst(4).compactMap { URL(string: $0) }
)
shot.start()
app.run()
