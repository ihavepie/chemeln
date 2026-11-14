import Cocoa
import WebKit

/**
 * 用法: jsrun <url> <js文件> [等待秒数] [窗口宽] [窗口高]
 *
 * 用系统 WebKit（跟 Safari 同一引擎）打开一个页面，等 `等待秒数` 后执行 JS，把返回值打到 stdout。
 * 跟 `print.swift` / `shot.swift` / `ocr.swift` 一样是「本机小工具」：第一次用到才编到 `.cache/jsrun`。
 *
 * 给 `scripts/check-pages.mjs` 用——那类检查（纸页高度、结果块还在不在）只能在真浏览器里量，
 * 又没有 puppeteer 那类依赖，所以借系统自带的 WKWebView。
 *
 * 返回值的约定：JS 那边自己 `JSON.stringify` 好再返回字符串，这边原样打一行。
 *
 * **实现上有个坑**：`js` / `pageURL` / `waitSec` 必须是**文件作用域的 `let`**（像下面这样）。
 * 用 `guard let js = ...` 那种条件绑定会编译报 `class declaration cannot close over value`；
 * 打包成全局 `var` 虽然能编译，但 `evaluateJavaScript` 会一直返回 nil（排查了很久）。
 * 参数不对就调 `bail()` 直接退出。
 */
func bail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(2)
}

let args = CommandLine.arguments
if args.count < 3 { bail("用法: jsrun <url> <js文件> [等待秒数] [宽] [高]") }

let maybeURL = URL(string: args[1])
if maybeURL == nil { bail("URL 不对: \(args[1])") }
let pageURL = maybeURL!
let maybeJS = try? String(contentsOfFile: args[2], encoding: .utf8)
if maybeJS == nil { bail("读不到 JS 文件: \(args[2])") }
let js = maybeJS!
let waitSec: Double = args.count > 3 ? (Double(args[3]) ?? 2.5) : 2.5
let winW: Double = args.count > 4 ? (Double(args[4]) ?? 1440) : 1440
let winH: Double = args.count > 5 ? (Double(args[5]) ?? 900) : 900

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let cfg = WKWebViewConfiguration()
cfg.websiteDataStore = .nonPersistent()
let view = WKWebView(frame: NSRect(x: 0, y: 0, width: winW, height: winH), configuration: cfg)
let win = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
win.contentView = view
win.orderFrontRegardless()

class Runner: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + waitSec) {
            webView.evaluateJavaScript(js) { value, error in
                if let error = error {
                    FileHandle.standardError.write("JS 出错: \(error)\n".data(using: .utf8)!)
                    exit(1)
                }
                if let text = value as? String {
                    print(text)
                } else if let value = value, !(value is NSNull) {
                    print(value)
                } else {
                    print("null")
                }
                exit(0)
            }
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("打开页面失败: \(error)\n".data(using: .utf8)!)
        exit(1)
    }
}

let runner = Runner()
view.navigationDelegate = runner
view.load(URLRequest(url: pageURL))
app.run()
