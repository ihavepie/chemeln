import Cocoa
import WebKit
import PDFKit

/// 用法: print <out.pdf> <w> <h> <page1.html> [page2.html ...]
/// 每个输入渲染成 A4 的一页，最后合成一个多页 PDF（createPDF 不自动分页，所以按页分发）。

final class PageRender: NSObject, WKNavigationDelegate {
    let web: WKWebView
    let url: URL
    var finished = false
    var data: Data?

    init(url: URL, w: CGFloat, h: CGFloat) {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()   // 不往 ~/Library/WebKit 里写东西
        self.web = WKWebView(frame: NSRect(x: 0, y: 0, width: w, height: h), configuration: cfg)
        self.url = url
        super.init()
        web.navigationDelegate = self
        web.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        waitImages(tries: 0)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finished = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finished = true
    }

    /// 等图片都加载完再出 PDF（谱图/结构式是 <img> 远程加载的）
    private func waitImages(tries: Int) {
        let js = "Array.from(document.images).filter(i => !i.complete || i.naturalWidth === 0).length"
        web.evaluateJavaScript(js) { value, _ in
            let pending = (value as? NSNumber)?.intValue ?? 0
            if pending == 0 || tries > 100 {
                self.render()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.waitImages(tries: tries + 1) }
            }
        }
    }

    private func render() {
        let cfg = WKPDFConfiguration()
        cfg.rect = CGRect(x: 0, y: 0, width: web.frame.width, height: web.frame.height)
        web.createPDF(configuration: cfg) { result in
            if case .success(let d) = result { self.data = d }
            self.finished = true
        }
    }
}

let args = CommandLine.arguments
guard args.count >= 5,
      let w = Double(args[2]), let h = Double(args[3]) else {
    FileHandle.standardError.write("usage: print <out.pdf> <w> <h> <page.html>...\n".data(using: .utf8)!)
    exit(2)
}
let out = URL(fileURLWithPath: args[1])
let pages = args.dropFirst(4).map { URL(string: $0) ?? URL(fileURLWithPath: $0) }

_ = NSApplication.shared
NSApplication.shared.setActivationPolicy(.prohibited)

var docs: [PDFDocument] = []
for url in pages {
    let r = PageRender(url: url, w: CGFloat(w), h: CGFloat(h))
    let deadline = Date().addingTimeInterval(40)
    while !r.finished && Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    guard let d = r.data, let doc = PDFDocument(data: d), doc.pageCount > 0 else {
        FileHandle.standardError.write("page failed: \(url)\n".data(using: .utf8)!)
        exit(1)
    }
    docs.append(doc)
}

let merged = PDFDocument()
for doc in docs {
    for i in 0..<doc.pageCount {
        if let p = doc.page(at: i) { merged.insert(p, at: merged.pageCount) }
    }
}
guard merged.write(to: out) else {
    FileHandle.standardError.write("write failed\n".data(using: .utf8)!)
    exit(1)
}
print("ok pages=\(merged.pageCount)")
