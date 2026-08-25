import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("usage: macos-ubiquity-status.swift /absolute/path\n", stderr)
    exit(64)
}

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)
let manager = FileManager.default
var output: [String: Any] = [
    "path": path,
    "exists": manager.fileExists(atPath: path),
    "isUbiquitous": manager.isUbiquitousItem(at: url),
]

do {
    let values = try url.resourceValues(forKeys: [
        .isUbiquitousItemKey,
        .ubiquitousItemIsUploadedKey,
        .ubiquitousItemIsUploadingKey,
        .ubiquitousItemUploadingErrorKey,
    ])
    if let value = values.isUbiquitousItem { output["resourceIsUbiquitous"] = value }
    if let value = values.ubiquitousItemIsUploaded { output["uploaded"] = value }
    if let value = values.ubiquitousItemIsUploading { output["uploading"] = value }
    if let value = values.ubiquitousItemUploadingError {
        output["uploadError"] = value.localizedDescription
    }
} catch {
    output["metadataError"] = error.localizedDescription
}

let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data([0x0a]))
