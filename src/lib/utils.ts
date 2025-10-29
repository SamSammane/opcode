import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combines multiple class values into a single string using clsx and tailwind-merge.
 * This utility function helps manage dynamic class names and prevents Tailwind CSS conflicts.
 *
 * @param inputs - Array of class values that can be strings, objects, arrays, etc.
 * @returns A merged string of class names with Tailwind conflicts resolved
 *
 * @example
 * cn("px-2 py-1", condition && "bg-blue-500", { "text-white": isActive })
 * // Returns: "px-2 py-1 bg-blue-500 text-white" (when condition and isActive are true)
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Get the display name for a Claude model identifier
 *
 * @param model - Model identifier (e.g., "opus", "sonnet", "haiku")
 * @returns Display name for the model
 *
 * @example
 * getModelDisplayName("opus") // Returns: "Claude 4 Opus"
 * getModelDisplayName("sonnet") // Returns: "Claude 3.5 Sonnet"
 */
export function getModelDisplayName(model: string): string {
  const modelMap: Record<string, string> = {
    'opus': 'Claude 4 Opus',
    'sonnet-4': 'Claude 4 Sonnet',
    'sonnet': 'Claude 3.5 Sonnet',
    'haiku': 'Claude 3.5 Haiku',
  };

  return modelMap[model] || model;
}

/**
 * Get the short display name for a Claude model identifier
 *
 * @param model - Model identifier (e.g., "opus", "sonnet", "haiku")
 * @returns Short display name for the model
 *
 * @example
 * getModelShortName("opus") // Returns: "Opus"
 * getModelShortName("sonnet") // Returns: "Sonnet"
 */
export function getModelShortName(model: string): string {
  const modelMap: Record<string, string> = {
    'opus': 'Opus',
    'sonnet-4': 'Sonnet 4',
    'sonnet': 'Sonnet',
    'haiku': 'Haiku',
  };

  return modelMap[model] || model;
} 