import Darwin
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("usage: macos-hold-file-lock.swift /absolute/path\n", stderr)
    exit(64)
}

let path = CommandLine.arguments[1]
let descriptor = open(path, O_RDWR)
guard descriptor >= 0 else {
    perror("open")
    exit(1)
}
defer { close(descriptor) }

guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
    perror("flock")
    exit(1)
}
defer { flock(descriptor, LOCK_UN) }

setbuf(stdout, nil)
print("LOCKED")
_ = readLine()
