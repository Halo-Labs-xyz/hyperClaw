"use client";
import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

const isIOS = () => {
  if (typeof window === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
};

const isStandalone = () => {
  if (typeof window === 'undefined') return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window.navigator as any).standalone || window.matchMedia('(display-mode: standalone)').matches;
};

export const InstallPWA = () => {
  const [supportsPWA, setSupportsPWA] = useState(false);
  const [promptInstall, setPromptInstall] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIOSInstructions, setShowIOSInstructions] = useState(false);
  const [isIOSDevice, setIsIOSDevice] = useState(false);
  const [isInStandalone, setIsInStandalone] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setIsIOSDevice(isIOS());
    setIsInStandalone(isStandalone());

    const handler = (e: Event) => {
      e.preventDefault();
      setSupportsPWA(true);
      setPromptInstall(e as BeforeInstallPromptEvent);
    };
    
    window.addEventListener("beforeinstallprompt", handler);

    if (isIOS() && !isStandalone()) {
      setShowIOSInstructions(true);
    }

    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const onClick = (evt: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
    evt.preventDefault();
    if (!promptInstall) return;
    promptInstall.prompt();
  };

  if (isInStandalone || dismissed) return null;
  if (!supportsPWA && !isIOSDevice) return null;

  return (
    <div className="fixed bottom-20 md:bottom-6 right-4 md:right-6 z-50 animate-fade-in-up">
      <div className="glass rounded-2xl p-4 max-w-xs shadow-soft">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent">
              <path d="M12 2v13m-4-4l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M20 17v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2" strokeLinecap="round" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-semibold text-sm text-foreground">Install App</h4>
            <p className="text-xs text-muted">
              {isIOSDevice ? "Add to Home Screen" : "Add to home screen"}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {supportsPWA && !isIOSDevice ? (
              <button 
                onClick={onClick} 
                type="button"
                className="btn-primary px-3 py-1.5 text-xs"
              >
                Install
              </button>
            ) : isIOSDevice ? (
              <button 
                onClick={() => setShowIOSInstructions(!showIOSInstructions)} 
                type="button"
                className="btn-primary px-3 py-1.5 text-xs"
              >
                How?
              </button>
            ) : null}
            <button
              onClick={() => setDismissed(true)}
              className="text-dim hover:text-muted transition-colors p-1"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        
        {showIOSInstructions && isIOSDevice && (
          <div className="mt-3 pt-3 border-t border-card-border">
            <div className="text-xs text-muted space-y-1.5">
              <p className="font-medium text-foreground">To install on iOS:</p>
              <p>1. Tap the Share button</p>
              <p>2. Scroll down and tap &quot;Add to Home Screen&quot;</p>
              <p>3. Tap &quot;Add&quot; to confirm</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
