import type { ComponentProps } from "react";
import {
  ArrowLeft,
  BookMarked,
  BookOpenText,
  Check,
  ChevronRight,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock3,
  CloudSun,
  Crop,
  Drama,
  Home,
  FileText,
  FolderOpen,
  Globe2,
  IdCard,
  Image,
  Images,
  Info,
  Landmark,
  LibraryBig,
  Link2,
  MapPin,
  MapPinned,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Shapes,
  Spade,
  Star,
  Swords,
  TriangleAlert,
  Copy,
  Download,
  Trash2,
  Upload,
  UserRound,
  UsersRound,
  Volume2,
  VolumeX,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";

/** 统一的 24×24、currentColor SVG 图标入口，替代平台相关的彩色 Emoji。 */
export type AppIconName =
  | "back" | "book" | "cards" | "characters" | "check" | "class" | "close"
  | "collapseAll" | "combat" | "content" | "copy" | "crop" | "docs" | "download"
  | "expandAll" | "file" | "folder" | "forward" | "globe" | "home" | "identity"
  | "image" | "images" | "index" | "info" | "location" | "map" | "pause" | "play"
  | "plus" | "refresh" | "save" | "search" | "sessions" | "settings" | "star"
  | "time" | "trash" | "upload" | "user" | "users" | "expand"
  | "volume" | "volumeOff" | "warning" | "weather" | "worldbook" | "workflow";

const ICONS: Record<AppIconName, LucideIcon> = {
  back: ArrowLeft,
  book: BookOpenText,
  cards: Spade,
  characters: Drama,
  check: Check,
  class: Shapes,
  close: X,
  collapseAll: ChevronsDownUp,
  combat: Swords,
  content: LibraryBig,
  copy: Copy,
  crop: Crop,
  docs: BookMarked,
  download: Download,
  expand: ChevronDown,
  expandAll: ChevronsUpDown,
  file: FileText,
  folder: FolderOpen,
  forward: ChevronRight,
  globe: Globe2,
  home: Home,
  identity: IdCard,
  image: Image,
  images: Images,
  index: Link2,
  info: Info,
  location: MapPin,
  map: MapPinned,
  pause: Pause,
  play: Play,
  plus: Plus,
  refresh: RefreshCw,
  save: Save,
  search: Search,
  sessions: Landmark,
  settings: Settings,
  star: Star,
  time: Clock3,
  trash: Trash2,
  upload: Upload,
  user: UserRound,
  users: UsersRound,
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
