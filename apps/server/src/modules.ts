import { manifest as cyberpunk } from "@tableloom/cyberpunk-red";
import { manifest as bikes } from "@tableloom/kids-on-bikes";
import { manifest as brooms } from "@tableloom/kids-on-brooms";

// Trusted, explicitly installed packages. Never resolve a caller-supplied path.
export const installedModules = [cyberpunk, bikes, brooms];
