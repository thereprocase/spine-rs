import {
  AlertTriangle, AlignJustify, ArrowUpDown, BookOpen, Check, ChevronDown,
  ChevronRight, ChevronUp, Circle, Clock, Columns3, Command, CornerDownLeft, File,
  FileWarning, Filter, Globe, LayoutGrid, Library, Link, List, Plus, Rows3, Search,
  Settings, Star, Tag, User, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Design prototype used 31 hand-drawn icons on a 20×20 viewbox. This wrapper
// maps the handoff's symbolic names onto Lucide (standard 24×24, stroke 1.5)
// so callsites keep the `<Icon name="search" />` ergonomics. Appearance is
// not pixel-identical to the prototype but the silhouettes match and Lucide
// ships maintained updates — an acceptable fidelity trade.
export type IconName =
  | "search" | "books" | "now" | "grid" | "list" | "rows" | "author" | "tag"
  | "series" | "clock" | "star" | "alert" | "check" | "cmd" | "add" | "settings"
  | "file" | "filemiss" | "link" | "loc" | "x" | "chev" | "chevdown" | "dot"
  | "sort" | "filter" | "density" | "up" | "down" | "circle" | "return";

// Use lucide-react's own LucideIcon type. Rolling our own
// `ComponentType<SVGProps<SVGSVGElement> & { size? }>` alias breaks under
// React 19 + lucide-react ≥1.x because the icons are
// `ForwardRefExoticComponent`, not the legacy `ComponentType` shape.
const ICON_MAP: Record<IconName, LucideIcon> = {
  search:   Search,
  books:    Library,
  now:      BookOpen,
  grid:     LayoutGrid,
  list:     List,
  rows:     Rows3,
  author:   User,
  tag:      Tag,
  series:   Columns3,
  clock:    Clock,
  star:     Star,
  alert:    AlertTriangle,
  check:    Check,
  cmd:      Command,
  add:      Plus,
  settings: Settings,
  file:     File,
  filemiss: FileWarning,
  link:     Link,
  loc:      Globe,
  x:        X,
  chev:     ChevronRight,
  chevdown: ChevronDown,
  dot:      Circle,
  sort:     ArrowUpDown,
  filter:   Filter,
  density:  AlignJustify,
  up:       ChevronUp,
  down:     ChevronDown,
  circle:   Circle,
  return:   CornerDownLeft,
};

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export default function Icon({ name, size = 14, color = "currentColor", strokeWidth = 1.5 }: IconProps) {
  const Component = ICON_MAP[name];
  return <Component size={size} color={color} strokeWidth={strokeWidth} />;
}
