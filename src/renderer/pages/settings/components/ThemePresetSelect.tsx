import { useCallback, useState } from 'react';

import CustomSelect from '@/components/CustomSelect';
import { themeRegistry } from '@/theme';

interface ThemePresetSelectProps {
  value: string;
  onPersistTheme: (themeId: string) => Promise<void>;
  onPersistError: (error: unknown) => void;
}

export function ThemePresetSelect({
  value,
  onPersistTheme,
  onPersistError,
}: ThemePresetSelectProps) {
  const [isSaving, setIsSaving] = useState(false);
  const options = themeRegistry.getAcceptedDefinitions().map(definition => {
    const swatches = themeRegistry.getPreviewSwatches(definition.id);
    return {
      value: definition.id,
      label: definition.displayName,
      content: <span className="block truncate">{definition.displayName}</span>,
      suffix: (
        <span aria-hidden="true" className="flex shrink-0 gap-1">
          <span
            className="h-4 w-4 rounded-sm border border-[var(--line)] shadow-sm"
            style={{ backgroundColor: swatches.light }}
          />
          <span
            className="h-4 w-4 rounded-sm border border-[var(--line)] shadow-sm"
            style={{ backgroundColor: swatches.dark }}
          />
        </span>
      ),
    };
  });

  const persistTheme = useCallback((themeId: string) => {
    if (themeId === value || isSaving) return;
    setIsSaving(true);
    void onPersistTheme(themeId)
      .catch(onPersistError)
      .finally(() => setIsSaving(false));
  }, [isSaving, onPersistError, onPersistTheme, value]);

  return (
    <CustomSelect
      value={value}
      options={options}
      onChange={persistTheme}
      disabled={isSaving}
      showSelectedSuffix
      size="md"
      className="w-56 shrink-0"
    />
  );
}
