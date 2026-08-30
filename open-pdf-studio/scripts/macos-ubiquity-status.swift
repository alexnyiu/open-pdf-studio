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
        .ubiquitousItemDownloadingStatusKey,
        .ubiquitousItemIsDownloadingKey,
        .ubiquitousItemDownloadingErrorKey,
        .ubiquitousItemHasUnresolvedConflictsKey,
        .ubiquitousItemIsUploadedKey,
        .ubiquitousItemIsUploadingKey,
        .ubiquitousItemUploadingErrorKey,
        .volumeIsLocalKey,
        .volumeIsRemovableKey,
        .volumeIsReadOnlyKey,
        .volumeLocalizedFormatDescriptionKey,
    ])
    if let value = values.isUbiquitousItem { output["resourceIsUbiquitous"] = value }
    if let value = values.ubiquitousItemDownloadingStatus { output["downloadStatus"] = value.rawValue }
    if let value = values.ubiquitousItemIsDownloading { output["downloading"] = value }
    if let value = values.ubiquitousItemDownloadingError {
        output["downloadError"] = value.localizedDescription
    }
    if let value = values.ubiquitousItemHasUnresolvedConflicts {
        output["unresolvedConflicts"] = value
    }
    if let value = values.ubiquitousItemIsUploaded { output["uploaded"] = value }
    if let value = values.ubiquitousItemIsUploading { output["uploading"] = value }
    if let value = values.ubiquitousItemUploadingError {
        output["uploadError"] = value.localizedDescription
    }
    if let value = values.volumeIsLocal { output["volumeIsLocal"] = value }
    if let value = values.volumeIsRemovable { output["volumeIsRemovable"] = value }
    if let value = values.volumeIsReadOnly { output["volumeIsReadOnly"] = value }
    if let value = values.volumeLocalizedFormatDescription { output["volumeType"] = value }
} catch {
    output["metadataError"] = error.localizedDescription
}

let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data([0x0a]))
