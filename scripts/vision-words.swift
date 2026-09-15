// Words with boxes from Apple's Vision text recogniser — the OCR behind Live Text — for one image.
//
//   vision-words <image> [lang ...]        e.g. vision-words page.jpg ru-RU
//
// Prints a tab-separated table: a first row "#size<TAB>width<TAB>height" in pixels, then one row per
// word — text, x0, y0, x1, y1 (pixels, origin top-left), confidence 0–100, line index — in reading
// order. A word's box is the bounding box of its quad, so a skewed line shows in the boxes drifting
// down the row. Language correction is off: the letters on the page are wanted, not the nearest
// dictionary word of a language the page may not be in (Bulgarian is read in Russian mode).
// Compiled by scripts/build-vision-words.sh; the server compiles it on first use in development.
import AppKit
import Foundation
import Vision

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: vision-words <image> [lang ...]\n".data(using: .utf8)!)
  exit(2)
}
guard let image = NSImage(contentsOfFile: args[1]), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("vision-words: cannot read \(args[1])\n".data(using: .utf8)!)
  exit(1)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
if args.count > 2 { request.recognitionLanguages = Array(args[2...]) }
do {
  try VNImageRequestHandler(cgImage: cg).perform([request])
} catch {
  FileHandle.standardError.write("vision-words: \(error)\n".data(using: .utf8)!)
  exit(1)
}
let width = Double(cg.width)
let height = Double(cg.height)
var out = "#size\t\(cg.width)\t\(cg.height)\n"
var line = 0
for observation in request.results ?? [] {
  guard let candidate = observation.topCandidates(1).first else { continue }
  let text = candidate.string
  let confidence = Int((candidate.confidence * 100).rounded())
  var start = text.startIndex
  while start < text.endIndex {
    if text[start] == " " { start = text.index(after: start); continue }
    var end = start
    while end < text.endIndex && text[end] != " " { end = text.index(after: end) }
    if let box = try? candidate.boundingBox(for: start..<end) {
      let b = box.boundingBox
      let x0 = Int((b.minX * width).rounded()), y0 = Int(((1 - b.maxY) * height).rounded())
      let x1 = Int((b.maxX * width).rounded()), y1 = Int(((1 - b.minY) * height).rounded())
      out += "\(text[start..<end])\t\(x0)\t\(y0)\t\(x1)\t\(y1)\t\(confidence)\t\(line)\n"
    }
    start = end
  }
  line += 1
}
FileHandle.standardOutput.write(out.data(using: .utf8)!)
