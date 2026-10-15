import Head from 'expo-router/head';
import { usePathname, type Href } from 'expo-router';
import { createContext, useContext, type PropsWithChildren, type ReactNode } from 'react';
import {
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ListRenderItem,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pt } from '@/lib/i18n/pt';
import { backTo } from '@/lib/navigation';
import { navigationShadow } from '@/theme/elevation';
import { useTheme } from '@/theme/ThemeProvider';
import { listGap, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { AppButton } from './AppButton';
import { AppNavLink } from './AppNavLink';
import { BrandBand, BrandWordmark } from './BrandBand';

/**
 * True where a layout owns the chrome: inside app/(tabs) the Tabs navigator
 * draws the brand header and the tab bar, and a modal has neither. The shell
 * then draws only the screen itself.
 */
export const ShellChromeContext = createContext(false);

export type MainTab = 'grupos' | 'rachas' | 'perfil';

/** The three main tabs, shared by the Tabs bar and by the shell outside the tabs. */
export function MainNavigation({ active, wide }: { active: MainTab | undefined; wide: boolean }) {
  const { colors, mode } = useTheme();
  const variant = wide ? 'rail' : 'tab';
  // The navigation keeps its DOM place (focus order, docs/15); only its look changed.
  return (
    <View
      accessibilityLabel={pt.navigation.label}
      role="navigation"
      style={[
        styles.navigation,
        wide ? styles.navigationWide : styles.navigationNarrow,
        { backgroundColor: colors.surface },
        wide ? undefined : navigationShadow(mode),
      ]}
    >
      <AppNavLink
        active={active === 'grupos'}
        href="/grupos"
        icon="users"
        label={pt.navigation.groups}
        variant={variant}
      />
      <AppNavLink
        active={active === 'rachas'}
        href="/rachas"
        icon="calendar"
        label={pt.navigation.matches}
        variant={variant}
      />
      <AppNavLink
        active={active === 'perfil'}
        href="/perfil"
        icon="user"
        label={pt.navigation.profile}
        variant={variant}
      />
    </View>
  );
}

export function BrandHeader() {
  return (
    <BrandBand>
      <View role="banner" style={styles.header}>
        <BrandWordmark />
      </View>
    </BrandBand>
  );
}

type ShellBandProps = {
  /**
   * The way back to the parent screen, shown above the title. It only takes
   * the parent's href: every back uses backTo (src/lib/navigation.ts).
   */
  back?: { label: string; href: Href; testID?: string };
  /** Closes a modal; a modal has no parent screen to go back to. */
  closeModal?: { label: string; onPress: () => void; testID?: string };
  /** Omitted (or empty) where the title and the scoreboard say enough, as on Grupos. */
  description?: string;
  eyebrow?: string;
  /** The screen's one scoreboard (docs/29 §1.2), shown in the band under the title. */
  hero?: ReactNode;
  title: string;
};

function ShellBand({ back, closeModal, description, eyebrow, hero, title }: ShellBandProps) {
  const { colors } = useTheme();
  const control = back
    ? { icon: 'arrow-left' as const, ...back, onPress: () => backTo(back.href) }
    : closeModal
      ? { icon: 'x' as const, ...closeModal }
      : undefined;
  return (
    <BrandBand rounded style={styles.band}>
      {control ? (
        <View style={styles.back}>
          <AppButton
            icon={control.icon}
            label={control.label}
            onPress={control.onPress}
            {...(control.testID === undefined ? {} : { testID: control.testID })}
            variant="tertiary"
          />
        </View>
      ) : null}
      <View style={styles.intro}>
        {eyebrow ? (
          <Text style={[styles.eyebrow, { color: colors.onBandMuted }]}>{eyebrow}</Text>
        ) : null}
        <Text aria-level={1} role="heading" style={[styles.title, { color: colors.onBand }]}>
          {title}
        </Text>
        {description ? (
          <Text style={[styles.description, { color: colors.onBandMuted }]}>{description}</Text>
        ) : null}
      </View>
      {hero}
    </BrandBand>
  );
}

function activeTab(pathname: string): MainTab | undefined {
  if (pathname.startsWith('/grupos') || pathname === '/join') return 'grupos';
  if (pathname.startsWith('/rachas')) return 'rachas';
  if (pathname.startsWith('/perfil')) return 'perfil';
  return undefined;
}

/** The frame of a screen: inside the tabs only the page title; outside, header and navigation too. */
function ShellFrame({ children, title }: PropsWithChildren<{ title: string }>) {
  const { colors } = useTheme();
  const insideTabs = useContext(ShellChromeContext);
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const wide = width >= 768;
  const head = (
    <Head>
      <title>{pt.app.pageTitle(title)}</title>
    </Head>
  );
  if (insideTabs) {
    return (
      <>
        {head}
        {children}
      </>
    );
  }
  const navigation = <MainNavigation active={activeTab(pathname)} wide={wide} />;
  return (
    <>
      {head}
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <BrandHeader />
        <View style={[styles.body, wide ? styles.bodyWide : undefined]}>
          {wide ? navigation : null}
          {children}
          {wide ? null : navigation}
        </View>
      </SafeAreaView>
    </>
  );
}

type AuthenticatedShellProps = PropsWithChildren<ShellBandProps>;

export function AuthenticatedShell({ children, ...band }: AuthenticatedShellProps) {
  return (
    <ShellFrame title={band.title}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        style={styles.scrollView}
      >
        <View role="main" style={styles.main} testID="authenticated-main">
          <ShellBand {...band} />
          <View style={styles.content}>{children}</View>
        </View>
      </ScrollView>
    </ShellFrame>
  );
}

type AuthenticatedListShellProps<T> = ShellBandProps & {
  /** Shown between the band and the first row: notices, actions, headings. */
  children?: ReactNode;
  data: readonly T[];
  keyExtractor: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** Shown after the last row: secondary actions. */
  footer?: ReactNode;
};

/**
 * The same screen as AuthenticatedShell with the list as the scroller: a
 * FlatList whose header is the band, so no list is nested in a ScrollView.
 */
export function AuthenticatedListShell<T>({
  children,
  data,
  footer,
  keyExtractor,
  renderItem,
  ...band
}: AuthenticatedListShellProps<T>) {
  const render: ListRenderItem<T> = ({ item }) => (
    <View style={styles.row}>{renderItem(item)}</View>
  );
  return (
    <ShellFrame title={band.title}>
      <FlatList
        ItemSeparatorComponent={RowSeparator}
        ListFooterComponent={footer ? <View style={styles.footer}>{footer}</View> : null}
        ListHeaderComponent={
          <>
            <ShellBand {...band} />
            {children ? <View style={styles.content}>{children}</View> : null}
          </>
        }
        contentContainerStyle={[styles.scrollContent, styles.main]}
        data={data}
        keyExtractor={keyExtractor}
        keyboardShouldPersistTaps="handled"
        renderItem={render}
        role="main"
        style={styles.scrollView}
        testID="authenticated-main"
      />
    </ShellFrame>
  );
}

function RowSeparator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  // The text-only button keeps its 48 px target; its text lines up with the title.
  back: { alignItems: 'flex-start', marginBottom: -spacing.sm, marginLeft: -spacing.md },
  band: { gap: spacing.lg, paddingBottom: spacing.lg, paddingHorizontal: spacing.lg },
  body: { flex: 1, minWidth: 0 },
  bodyWide: { alignSelf: 'center', flexDirection: 'row', maxWidth: 1160, width: '100%' },
  content: { gap: spacing.lg, padding: spacing.lg },
  description: { ...typography.body, maxWidth: 680 },
  eyebrow: { ...typography.supportStrong },
  footer: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  header: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
    maxWidth: 1160,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.ms,
    width: '100%',
  },
  intro: { gap: spacing.xs, minWidth: 0, paddingTop: spacing.sm },
  main: { alignSelf: 'center', maxWidth: 820, minWidth: 0, width: '100%' },
  navigation: { gap: spacing.xs },
  navigationNarrow: { flexDirection: 'row', justifyContent: 'space-around' },
  navigationWide: {
    alignSelf: 'stretch',
    minWidth: 200,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.lg,
  },
  row: { paddingHorizontal: spacing.lg },
  safeArea: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: spacing.xxl },
  scrollView: { flex: 1, minWidth: 0 },
  separator: { height: listGap },
  title: { ...typography.display },
});
