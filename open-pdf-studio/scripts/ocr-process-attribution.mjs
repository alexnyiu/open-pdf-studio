export function isMacWebKitXpc(entry) {
  return entry.ppid === 1 && entry.command.includes('com.apple.WebKit.');
}

export function createOcrProcessAttribution() {
  return {
    initialized: false,
    baselineWebKitPids: new Set(),
    childPids: new Set(),
    childWebKitPids: new Set(),
  };
}

export function updateMacOcrProcessAttribution(attribution, processes, activeChildren) {
  for (const child of activeChildren) attribution.childPids.add(child.pid);

  if (!attribution.initialized) {
    for (const entry of processes) {
      if (isMacWebKitXpc(entry)) attribution.baselineWebKitPids.add(entry.pid);
    }
  }

  // Only an XPC process born while a currently active one-job child exists can
  // join that child's cohort. Never revisit exited children: a later unrelated
  // WebKit process can otherwise look adjacent after enough PID churn.
  for (const { pid: childPid } of activeChildren) {
    for (const entry of processes) {
      if (isMacWebKitXpc(entry) && entry.pid > childPid && entry.pid - childPid <= 512 &&
          !attribution.baselineWebKitPids.has(entry.pid)) {
        attribution.childWebKitPids.add(entry.pid);
      }
    }
  }

  attribution.initialized = true;
}
