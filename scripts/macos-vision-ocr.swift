// macos-vision-ocr.swift — VNRecognizeTextRequest 包装，stdin PNG path / stdout 文字
// Build: swiftc -O macos-vision-ocr.swift -o macos-vision-ocr
// Run:   ./macos-vision-ocr <png-path>
import Vision
import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("Usage: macos-vision-ocr <png-path>\n".data(using: .utf8)!)
    exit(2)
}

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)
guard let img = NSImage(contentsOf: url),
      let fullCg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("Failed to load image: \(path)\n".data(using: .utf8)!)
    exit(3)
}

// Crop left 25% to exclude Obsidian's icon sidebar + file tree which
// otherwise dominate OCR output with noise (icons mis-recognized as 白/Q/仨/口
// etc.). Obsidian default left sidebar is ~15-20% of window width; 25% gives
// safe margin while preserving the note content pane on the right.
// audit-via-subagents v3 — fix discovered during 5125541 Task 6 validation
// when obsidian frame .txt files were dominated by sidebar icon noise instead
// of article text.
let leftSkip = Int(Double(fullCg.width) * 0.25)
let cropRect = CGRect(x: leftSkip, y: 0, width: fullCg.width - leftSkip, height: fullCg.height)
guard let cg = fullCg.cropping(to: cropRect) else {
    FileHandle.standardError.write("Failed to crop image\n".data(using: .utf8)!)
    exit(3)
}

let request = VNRecognizeTextRequest { req, err in
    if let e = err {
        FileHandle.standardError.write("Vision error: \(e)\n".data(using: .utf8)!)
        return
    }
    let texts = (req.results as? [VNRecognizedTextObservation])?
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n") ?? ""
    FileHandle.standardOutput.write(texts.data(using: .utf8)!)
}
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

do {
    try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
} catch {
    FileHandle.standardError.write("Recognition failed: \(error)\n".data(using: .utf8)!)
    exit(4)
}
