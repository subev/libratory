// The only file allowed to import @phosphor-icons/react. Names are what the app calls the thing,
// not what Phosphor calls it, so the set can be swapped without touching call sites.
// Need one that is not here? Find it at phosphoricons.com and add a line — never inline an SVG.
export {
  X as IconClose,
  Plus as IconAdd,
  Check as IconCheck,
  Warning as IconWarning,
  Trash as IconDelete,
  PencilSimple as IconRename,
  MagnifyingGlass as IconSearch,
  UploadSimple as IconUpload,
  Gear as IconSettings,
  User as IconProfile,
  DotsSixVertical as IconDragHandle,
  DotsThree as IconMore,
  LockSimple as IconLocked,
  ArrowsOutSimple as IconExpand,
  Sparkle as IconAi,
  DownloadSimple as IconDownload,
  PlayCircle as IconContinue,
  Play as IconPlay,
  Pause as IconPause,
  Stop as IconStop,
  Microphone as IconMicrophone,
  CircleNotch as IconSpinner,
  ArrowsClockwise as IconRefresh,
  Folder as IconFolder,
  FileText as IconDocument,
  BookOpen as IconBook,
  ChatCircle as IconChat,
  ListBullets as IconStructure,
  Translate as IconTranslate,
  HardDrives as IconDisk,
  CaretLeft as IconChevronLeft,
  CaretRight as IconChevronRight,
  CaretUp as IconChevronUp,
  CaretDown as IconChevronDown,
  ArrowLeft as IconArrowLeft,
  ArrowRight as IconArrowRight,
  ArrowSquareOut as IconExternal,
  Sun as IconThemeLight,
  Moon as IconThemeDark,
} from "@phosphor-icons/react";

import type { ReactNode } from "react";
import { IconContext } from "@phosphor-icons/react";

const DEFAULTS = { size: "1em", weight: "regular", "aria-hidden": true } as const;

// Phosphor sets no aria-hidden, so every decorative icon would land in the accessibility tree as an
// unnamed graphic. size stays "1em" because dropping it omits width/height and the SVG fills its box.
export function IconDefaults({ children }: { children: ReactNode }) {
  return (
    <IconContext.Provider value={DEFAULTS}>
      {children}
    </IconContext.Provider>
  );
}
