import { useState } from "react";
import { Button } from "../Button.tsx";
import { ProfileSwitcher } from "../ProfileSwitcher.tsx";
import { SettingsModal } from "../SettingsModal.tsx";
import { AssistantToggle } from "../assistant/AssistantPanel.tsx";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { IconBook, IconPhone, IconSettings } from "../icons.tsx";

// The library's header, shared by the home page and the Phone page so switching between them
// moves nothing: profile, the two ways out of the library (a read-along EPUB, a phone), and settings.
export function LibraryHeader({ page }: { page: "library" | "phone" }) {
  const [showSettings, setShowSettings] = useState(false);
  return (
    <div className="flex items-center gap-2 h-12 px-4 border-b border-(--border) bg-(--bg-card)">
      <h1 className="font-(family-name:--stack-display) text-[17px] font-semibold tracking-tight text-(--text-primary)">
        Libratory
      </h1>
      <ProfileSwitcher />
      <div className="flex-1" />
      <Button
        variant="secondary"
        size="sm"
        to="/open"
        title="Open a synced EPUB and read along on its own pages — nothing is uploaded"
        data-testid="open-container-link"
      >
        <IconBook className="h-4 w-4" />
        Open a read-along EPUB
      </Button>
      {/* Lit on its own page, the way the design shows it, rather than disabled and greyed */}
      <Button
        variant={page === "phone" ? "primary" : "secondary"}
        size="sm"
        to="/phone"
        title="Add this profile's shelf to a phone, and see what the paired phones can reach"
        data-testid="phone-page-link"
      >
        <IconPhone className="h-4 w-4" />
        Phone
      </Button>
      <AssistantToggle />
      <ThemeToggle />
      <Button
        variant="icon"
        size="sm"
        onClick={() => setShowSettings(true)}
        title="AI model settings"
        aria-label="AI model settings"
        data-testid="settings-gear"
      >
        <IconSettings className="h-4 w-4" />
      </Button>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
