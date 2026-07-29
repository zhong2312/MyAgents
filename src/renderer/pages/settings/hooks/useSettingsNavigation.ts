import { useCallback, useEffect, useRef, useState } from 'react';

import {
  VALID_SECTIONS,
  type SettingsSection,
} from '../settingsSections';

interface UseSettingsNavigationParams {
  initialSection?: string;
  navigationNonce?: number;
  floatingBallDevGate?: boolean;
  onSectionChange?: () => void;
}

export function useSettingsNavigation({
  initialSection,
  navigationNonce,
  floatingBallDevGate,
  onSectionChange,
}: UseSettingsNavigationParams) {
  const onSectionChangeRef = useRef(onSectionChange);
  const floatingBallDisabled = floatingBallDevGate === false;

  useEffect(() => {
    onSectionChangeRef.current = onSectionChange;
  }, [onSectionChange]);

  const getInitialSection = (): SettingsSection => {
    if (initialSection && VALID_SECTIONS.includes(initialSection as SettingsSection)) {
      if (initialSection === 'desktop-pet' && floatingBallDisabled) {
        return 'about';
      }
      return initialSection as SettingsSection;
    }
    return 'providers';
  };

  const [activeSection, setActiveSection] = useState<SettingsSection>(getInitialSection);

  const notifySectionChange = useCallback(() => {
    onSectionChangeRef.current?.();
  }, []);

  useEffect(() => {
    if (initialSection && VALID_SECTIONS.includes(initialSection as SettingsSection)) {
      const timer = window.setTimeout(() => {
        if (initialSection === 'desktop-pet' && floatingBallDisabled) {
          setActiveSection('about');
          notifySectionChange();
          return;
        }
        setActiveSection(initialSection as SettingsSection);
        notifySectionChange();
      }, 0);

      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [floatingBallDisabled, initialSection, navigationNonce, notifySectionChange]);

  useEffect(() => {
    if (activeSection === 'desktop-pet' && floatingBallDisabled) {
      const timer = window.setTimeout(() => {
        setActiveSection('about');
      }, 0);

      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeSection, floatingBallDisabled]);

  const navigateToProxySettings = useCallback(() => {
    setActiveSection('proxy');
  }, []);

  return {
    activeSection,
    setActiveSection,
    navigateToProxySettings,
    notifySectionChange,
  };
}
