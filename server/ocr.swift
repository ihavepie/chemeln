import Foundation
import Vision
import AppKit

/// 本地 OCR：读一张图里的文字（TLC 板照片上手写的「PE:EA = 10:1」这类）。
/// 用系统的 Vision 框架，不联网、不引第三方库。
/// 用法: ocr <图片路径>     → 打印 [{"text": "...", "conf": 0.3}, ...] 的 JSON

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: ocr <image>\n".data(using: .utf8)!)
  exit(2)
}

guard let img = NSImage(contentsOfFile: args[1]),
      let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let cg = rep.cgImage else {
  FileHandle.standardError.write("读不出这张图\n".data(using: .utf8)!)
  exit(3)
}

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
// 手写的溶剂配比基本是拉丁字母 + 数字，中文偶尔有（「石油醚/乙酸乙酯」）
req.recognitionLanguages = ["zh-Hans", "en-US"]
req.usesLanguageCorrection = false

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
  try handler.perform([req])
} catch {
  FileHandle.standardError.write("OCR 失败：\(error.localizedDescription)\n".data(using: .utf8)!)
  exit(4)
}

var out: [[String: Any]] = []
for obs in (req.results ?? []) {
  guard let c = obs.topCandidates(1).first else { continue }
  let box = obs.boundingBox
  out.append([
    "text": c.string,
    "conf": Double(c.confidence),
    // 位置（0–1，左下原点）：前端按它把「靠近 Rf 那行」和「展开剂那行」分开
    "x": Double(box.origin.x),
    "y": Double(box.origin.y),
    "w": Double(box.size.width),
    "h": Double(box.size.height),
  ])
}

let data = try JSONSerialization.data(withJSONObject: out, options: [])
print(String(data: data, encoding: .utf8)!)
