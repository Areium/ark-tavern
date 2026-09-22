import type { ComponentProps } from "react";
import {
  ArrowLeft,
  BookMarked,
  BookOpenText,
  ChevronRight,
  ChevronDown,
  Clock3,
  CloudSun,
  Drama,
  Home,
  FileText,
  FolderOpen,
  Globe2,
  Image,
  Landmark,
  LibraryBig,
  Link2,
  Lock,
  MapPin,
  MapPinned,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings,
  Spade,
  Star,
  Swords,
  TriangleAlert,
  Copy,
  Download,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/** 统一的 24×24、currentColor SVG 图标入口，替代平台相关的彩色 Emoji。 */
export type AppIconName =
  | "back" | "book" | "cards" | "characters" | "combat" | "content"
  | "copy" | "docs" | "download" | "file" | "folder" | "forward" | "globe"
  | "home" | "image" | "index" | "location" | "lock" | "map" | "pause" | "play"
  | "refresh" | "search" | "sessions" | "settings" | "star" | "time" | "trash"
  | "upload" | "expand"
  | "volume" | "volumeOff" | "warning" | "weather" | "worldbook" | "workflow";

const ICONS: Record<AppIconName, LucideIcon> = {
  back: ArrowLeft,
  book: BookOpenText,
  cards: Spade,
  characters: Drama,
  combat: Swords,
  content: LibraryBig,
  copy: Copy,
  docs: BookMarked,
  download: Download,
  expand: ChevronDown,
  file: FileText,
  folder: FolderOpen,
  forward: ChevronRight,
  globe: Globe2,
  home: Home,
  image: Image,
  index: Link2,
  location: MapPin,
  lock: Lock,
  map: MapPinned,
  pause: Pause,
  play: Play,
  refresh: RefreshCw,
  search: Search,
  sessions: Landmark,
  settings: Settings,
  star: Star,
  time: Clock3,
  trash: Trash2,
  upload: Upload,
  volume: Volume2,
  volumeOff: VolumeX,
  warning: TriangleAlert,
  weather: CloudSun,
  worldbook: BookOpenText,
  workflow: Workflow,
};

interface AppIconProps extends Omit<ComponentProps<"svg">, "name"> {
  name: AppIconName;
  size?: number | string;
}

export default function AppIcon({ name, size = 16, strokeWidth = 1.8, className = "", ...props }: AppIconProps) {
  const Icon = ICONS[name];
  return (
    <Icon
      aria-hidden="true"
      focusable="false"
      size={size}
      strokeWidth={strokeWidth}
      className={`inline-block shrink-0 align-middle ${className}`.trim()}
      {...props}
    />
  );
}
