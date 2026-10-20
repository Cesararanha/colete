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
import { gutter, listGap, radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { AppButton } from './AppButton';
import { AppNavLink } from './AppNavLink';
import { BrandBand, BrandWordmark } from './BrandBand';
import { ProfileAvatarLink } from './ProfileAvatarLink';

/**
 * True where a layout owns the chrome: inside app/(tabs) the Tabs navigator
 * draws the brand header and the tab bar, and a modal has neither. The shell
 * then draws only the screen itself.
 */
export const ShellChromeContext = createContext(false);

export type MainTab = 'grupos' | 'rachas';

/**
 * The two main tabs (prévia aprovada), shared by the Tabs bar and by the shell
 * outside the tabs. The profile left the bar: it opens from the avatar at the
 * top right of every screen (ProfileAvatarLink).
 */
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
      testID={wide ? 'main-navigation-rail' : 'main-navigation-bar'}
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
    </View>
  );
}

type ShellBandProps = {
  /**
   * The way back to the parent screen, at the top left in place of the
   * wordmark. The label is the parent's name (prévia aprovada); the
   * accessible name adds "Voltar para" unless the label already says it.
   * Every back uses backTo (src/lib/navigation.ts) unless `onPress` replaces it.
   */
  back?: { label: string; href: Href; testID?: string; onPress?: () => void };
  /** Closes a modal; a modal has no parent screen to go back to. */
  closeModal?: { label: string; onPress: () => void; testID?: string };
  /** Omitted (or empty) where the title and the scoreboard say enough, as on Grupos. */
  description?: string;
  /** The screen's one scoreboard (docs/29 §1.2), shown in the band under the title. */
  hero?: ReactNode;
  /**
   * Replaces the h1 and description when the screen draws its own top (the
   * group's icon and name, the profile's avatar and name). `title` still
   * names the page.
   */
  intro?: ReactNode;
  /** `heading` (28) on screens below a tab; `display` (32) on Grupos and Agenda. */
  titleSize?: 'display' | 'heading';
  title: string;
  /** Replaces the avatar at the top right (Perfil: Editar). `null` leaves the corner empty. */
  trailing?: ReactNode;
};

/**
 * The top of every authenticated screen (prévia aprovada): the way back, or
 * the COLETE wordmark on a tab's first screen, and the avatar that opens the
 * profile. It stays above the scroller, outside the main region.
 */
function TopBar({ back, closeModal, trailing }: ShellBandProps) {
  const control = back
    ? {
        accessibilityLabel: /^Voltar/u.test(back.label)
          ? back.label
          : pt.navigation.back(back.label),
        icon: 'chevron-left' as const,
        label: back.label,
        onPress: back.onPress ?? (() => backTo(back.href)),
        testID: back.testID,
      }
    : closeModal
      ? { accessibilityLabel: closeModal.label, icon: 'x' as const, ...closeModal }
      : undefined;
  // A modal is a form on its own: no way out through the profile from it.
  const corner = trailing === undefined ? closeModal ? null : <ProfileAvatarLink /> : trailing;
  return (
    <BrandBand>
      <View role="banner" style={styles.topBar}>
        {control ? (
          <View style={styles.back}>
            <AppButton
              accessibilityLabel={control.accessibilityLabel}
              icon={control.icon}
              label={control.label}
              onPress={control.onPress}
              singleLine
              {...(control.testID === undefined ? {} : { testID: control.testID })}
              variant="tertiary"
            />
          </View>
        ) : (
          <BrandWordmark />
        )}
        {corner}
      </View>
    </BrandBand>
  );
}

function ShellBand({ description, hero, intro, title, titleSize = 'heading' }: ShellBandProps) {
  const { colors } = useTheme();
  return (
    <BrandBand rounded style={styles.band}>
      {intro ?? (
        <View style={styles.intro}>
          <Text
            aria-level={1}
            role="heading"
            style={[
              titleSize === 'display' ? styles.title : styles.heading,
              { color: colors.onBand },
            ]}
          >
            {title}
          </Text>
          {description ? (
            <Text style={[styles.description, { color: colors.onBandMuted }]}>{description}</Text>
          ) : null}
        </View>
      )}
      {hero}
    </BrandBand>
  );
}

function activeTab(pathname: string): MainTab | undefined {
  if (pathname.startsWith('/grupos') || pathname === '/join') return 'grupos';
  if (pathname.startsWith('/rachas')) return 'rachas';
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
      <View style={styles.screen}>
        <TopBar {...band} />
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
      </View>
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
      <View style={styles.screen}>
        <TopBar {...band} />
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
      </View>
    </ShellFrame>
  );
}

function RowSeparator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  // The text-only button keeps its 48 px target; its chevron lines up with the gutter.
  back: { alignItems: 'flex-start', flexShrink: 1, marginLeft: -spacing.ms, minWidth: 0 },
  band: { gap: spacing.md, paddingBottom: spacing.sm, paddingHorizontal: gutter },
  body: { flex: 1, minWidth: 0 },
  bodyWide: { alignSelf: 'center', flexDirection: 'row', maxWidth: 1160, width: '100%' },
  content: { gap: spacing.md, paddingHorizontal: gutter, paddingVertical: spacing.md },
  description: { ...typography.support, maxWidth: 680 },
  footer: { gap: spacing.sm, paddingHorizontal: gutter, paddingTop: spacing.lg },
  heading: { ...typography.heading },
  intro: { gap: spacing.xs, minWidth: 0, paddingTop: spacing.xs },
  main: { alignSelf: 'center', maxWidth: 820, minWidth: 0, width: '100%' },
  navigation: { gap: spacing.xs },
  navigationNarrow: {
    borderTopLeftRadius: radius.scoreboard,
    borderTopRightRadius: radius.scoreboard,
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  navigationWide: {
    alignSelf: 'stretch',
    minWidth: 200,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.lg,
  },
  row: { paddingHorizontal: gutter },
  safeArea: { flex: 1 },
  screen: { flex: 1, minWidth: 0 },
  scrollContent: { flexGrow: 1, paddingBottom: spacing.xxl },
  scrollView: { flex: 1, minWidth: 0 },
  separator: { height: listGap },
  title: { ...typography.display },
  topBar: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
    maxWidth: 820,
    minHeight: size.compact + spacing.ms + spacing.sm,
    paddingBottom: spacing.sm,
    paddingHorizontal: gutter,
    paddingTop: spacing.ms,
    width: '100%',
  },
});
