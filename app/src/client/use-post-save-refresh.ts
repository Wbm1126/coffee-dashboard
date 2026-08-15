import { useState } from 'react';

export function usePostSaveRefresh(onDataChanged: () => Promise<void>, onSaved: () => void = () => undefined) {
  const [refreshPending, setRefreshPending] = useState(false);

  const refreshAfterSave = async () => {
    try {
      await onDataChanged();
      setRefreshPending(false);
      onSaved();
      return true;
    } catch {
      setRefreshPending(true);
      return false;
    }
  };

  return { refreshPending, refreshAfterSave };
}
