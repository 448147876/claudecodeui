import { useState, useEffect } from 'react';

import { APP_VERSION } from '@/shared/constants';
import type { InstallMode, ReleaseInfo } from '@/shared/types';

// cloudcli-multi: upstream polled GitHub releases for an "update available"
// notice; this deployment updates through `cloudcli-multi update`, so the
// check is gone and these stay empty. Only the local restart hint remains.
const updateAvailable = false;
const latestVersion: string | null = null;
const releaseInfo: ReleaseInfo | null = null;

export const useVersionCheck = () => {
  const [installMode, setInstallMode] = useState<InstallMode>('git');
  const [runningVersion, setRunningVersion] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const response = await fetch('/health');
        const data = await response.json();
        if (data.installMode === 'npm' || data.installMode === 'git') {
          setInstallMode(data.installMode);
        }
        // `data.version` is the version the server process is actually running.
        // This module's `version` is baked into the frontend bundle at build
        // time, so it reflects the installed (on-disk) package. If they differ,
        // the package was updated but the server process was not restarted, and
        // DB-backed actions may silently fail until it is.
        if (typeof data.version === 'string' && data.version.length > 0) {
          setRunningVersion(data.version);
          setRestartRequired(data.version !== APP_VERSION);
        }
      } catch {
        // Default to git / no restart hint on error
      }
    };
    fetchHealth();
  }, []);

  return { updateAvailable, latestVersion, currentVersion: APP_VERSION, releaseInfo, installMode, runningVersion, restartRequired };
};
