import Cocoa
import WebKit

/**
 * 用法: shot <out> <宽> <url> [输出宽 snapWidth]
 *
 * 把整页（不是视口）截成一张图：加载 → 等图 → 量出实际高度 → 把窗口撑到那么高 → 截图。
 * `out` 以 `.pdf` 结尾时不是存图，而是把这张截图**铺满一页 PDF**（页面尺寸按 CSS px 折算成 pt，
 * 也就是「截图做的 PDF」）——排版/字体全由 WebKit 画好再固定成位图，不会像矢量 PDF 那样在
 * 字体、裁切、跨页上出幺蛾子。
 * `snapWidth` 给了就按这个像素宽出图（A4 宽 794 CSS px 时给 1588 就是 2 倍、2382 约 3 倍）。
 *
 * 和 print.swift 一样用系统 WebKit（跟 Safari 同一引擎），版面与浏览器里看到的一致。
 */
final class Shot: NSObject, WKNavigationDelegate {
    let out: String
    let width: CGFloat
    let snapWidth: CGFloat
    let web: WKWebView
    var done = false

    init(out: String, width: CGFloat, snapWidth: CGFloat, url: URL) {
        self.out = out
        self.width = width
        self.snapWidth = snapWidth
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
                    if self.snapWidth > 0 { cfg.snapshotWidth = NSNumber(value: Double(self.snapWidth)) }
                    webView.takeSnapshot(with: cfg) { img, _ in
                        guard let img else { print("SNAPFAIL"); exit(1) }
                        if self.out.lowercased().hasSuffix(".pdf") {
                            self.writePDF(img, h: h)
                        } else {
                            self.writePNG(img)
                        }
                    }
                }
            }
        }
    }

    /// 截图铺满一页 PDF（页面大小 = 截图对应的 CSS 尺寸，1px = 0.75pt）
    private func writePDF(_ img: NSImage, h: CGFloat) {
        let pageW = self.width * 72.0 / 96.0
        let pageH = h * 72.0 / 96.0
        var mediaBox = CGRect(x: 0, y: 0, width: pageW, height: pageH)
        guard let consumer = CGDataConsumer(url: URL(fileURLWithPath: self.out) as CFURL),
              let ctx = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else {
            print("PDFFAIL"); exit(1)
        }
        ctx.beginPDFPage(nil)
        if let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            // 实测：直接 draw 就是正的（先按老经验翻了一次，结果整页倒过来）
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: pageW, height: pageH))
        }
        ctx.endPDFPage()
        ctx.closePDF()
        print("ok \(Int(h)) pdf")
        exit(0)
    }

    private func writePNG(_ img: NSImage) {
        guard let tiff = img.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            print("SNAPFAIL"); exit(1)
        }
        do {
            try png.write(to: URL(fileURLWithPath: self.out))
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
    snapWidth: a.count > 4 ? CGFloat(Double(a[4]) ?? 0) : 0,
    url: URL(string: a[3])!
)
app.run()
