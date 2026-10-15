import { router, type Href } from 'expo-router';

/**
 * The one "Voltar" of a screen inside a tab: back to its parent screen.
 *
 * dismissTo is the stack's POP_TO. When the parent is already in this tab's
 * stack (normal navigation) it pops back to it; when it is not (a URL opened
 * directly, or a screen reached by replace, as Convites after creating a
 * group) it replaces the current screen with the parent. Either way the tab
 * keeps one parent and the root keeps one tab navigator. router.navigate
 * would push a second parent in React Navigation 7, and router.replace from
 * outside the tabs would add a second tab navigator.
 */
export function backTo(href: Href): void {
  router.dismissTo(href);
}
