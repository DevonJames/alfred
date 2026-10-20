/**
 * Settings (§12.5, §10.4, §11.4).
 *
 * Privacy mode is read from the desktop and can only be *tightened* here. The
 * phone is not allowed to loosen it — that decision belongs on the machine that
 * holds the data, and the UI says so rather than silently failing.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect, type Href } from "expo-router";
import { Check, Lock } from "lucide-react-native";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Backdrop,
  Button,
  Card,
  ConnectionPill,
  Display,
  Label,
  Loading,
  Notice,
  Sheet,
} from "@/components/ui";
import { unlinkDesktop } from "@/lib/cloud-api";
import { cn } from "@/lib/cn";
import { useConnection } from "@/lib/connection";
import {
  desktopErrorMessage,
  getBriefingPrefs,
  getSettings,
  isNotBuiltYet,
  patchSettings,
  putBriefingPrefs,
  rebuildIndexes,
  revokePairing,
  verifyMemory,
} from "@/lib/desktop-api";
import { rediscover } from "@/lib/discovery";
import { useMirror } from "@/lib/memory-cache";
import { syncMirror, useMirrorSync } from "@/lib/mirror-sync";
import { describeCopy } from "@/lib/recall";
import {
  isRobotAudioEnabled,
  isRobotClaimed,
  isRobotTalkEnabled,
  setRobotTalkEnabled,
  setTalkAudioRoute,
} from "@/lib/robot-audio";
import { storageIsSecure } from "@/lib/secure-store";
import { useSession } from "@/lib/session";
import type { BriefingPrefs, BriefingPrefsCatalog, DesktopSettings } from "@/lib/types";

const PRIVACY: { key: DesktopSettings["privacyMode"]; title: string; detail: string; rank: number }[] = [
  {
    key: "local_only",
    title: "Local only",
    detail: "Nothing leaves your Mac. No cloud models, ever.",
    rank: 0,
  },
  {
    key: "private_hybrid",
    title: "Private hybrid",
    detail: "Your Mac may use cloud models for reasoning, but your memory stays local.",
    rank: 1,
  },
  {
    key: "user_managed",
    title: "User managed",
    detail: "You've configured the boundaries yourself on the desktop.",
    rank: 2,
  },
];

export default function Settings() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const mode = useConnection((s) => s.mode);
  const discovering = useConnection((s) => s.discovering);
  const email = useConnection((s) => s.email);
  const serverUrl = useConnection((s) => s.serverUrl);
  const serverId = useConnection((s) => s.serverId);
  const cloudToken = useConnection((s) => s.cloudToken);
  const connected = useConnection((s) => Boolean(s.serverUrl));
  const paired = useConnection((s) => Boolean(s.deviceToken));

  const [confirm, setConfirm] = useState<"unpair" | "unlink" | "reset" | null>(null);
  const [briefPrefsOpen, setBriefPrefsOpen] = useState(false);
  const [robotAudio, setRobotAudio] = useState(false);
  const [robotClaimed, setRobotClaimed] = useState(false);
  const [robotTalk, setRobotTalk] = useState(false);
  const [audioRouteError, setAudioRouteError] = useState<string | null>(null);
  const [audioRouteBusy, setAudioRouteBusy] = useState(false);
  const [talkModeBusy, setTalkModeBusy] = useState(false);

  const refreshRobot = useCallback(() => {
    void Promise.all([isRobotAudioEnabled(), isRobotClaimed(), isRobotTalkEnabled()]).then(
      ([audio, claimed, talk]) => {
        setRobotAudio(audio);
        setRobotClaimed(claimed);
        setRobotTalk(talk);
      }
    );
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshRobot();
    }, [refreshRobot])
  );

  const mirrorEnabled = useMirror((s) => s.enabled);
  const mirrorCount = useMirror((s) => Object.keys(s.records).length);
  const mirrorSyncedAt = useMirror((s) => s.syncedAt);
  const mirrorSyncing = useMirrorSync((s) => s.syncing);

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    enabled: connected,
  });

  const updatePrivacy = useMutation({
    mutationFn: (privacyMode: DesktopSettings["privacyMode"]) => patchSettings({ privacyMode }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const verify = useMutation({ mutationFn: verifyMemory });
  const rebuild = useMutation({ mutationFn: rebuildIndexes });

  const briefPrefs = useQuery({
    queryKey: ["briefing", "prefs"],
    queryFn: getBriefingPrefs,
    enabled: connected && briefPrefsOpen,
  });

  const saveBriefPrefs = useMutation({
    mutationFn: (patch: Partial<BriefingPrefs>) => putBriefingPrefs(patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["briefing", "prefs"] });
      queryClient.invalidateQueries({ queryKey: ["briefing", "daily"] });
    },
  });

  const leave = useMutation({
    mutationFn: async (action: "unpair" | "unlink" | "reset") => {
      const state = useConnection.getState();
      if (action === "unpair") {
        await revokePairing().catch(() => {});
        await state.unpairDevice();
      }
      if (action === "unlink") {
        await revokePairing().catch(() => {});
        if (cloudToken && serverId) await unlinkDesktop(cloudToken, serverId).catch(() => {});
        await state.unpairDevice();
      }
      if (action === "reset") {
        await revokePairing().catch(() => {});
        if (cloudToken && serverId) await unlinkDesktop(cloudToken, serverId).catch(() => {});
        await state.signOut();
      }
      useSession.getState().reset();
      queryClient.clear();
      return action;
    },
    onSuccess: (action) => {
      setConfirm(null);
      router.replace(action === "reset" ? "/(onboarding)/claim" : "/(onboarding)/discovering");
    },
  });

  const current = settings.data?.settings;
  const currentRank = PRIVACY.find((p) => p.key === current?.privacyMode)?.rank ?? 0;

  return (
    <Backdrop>
      <ScrollView
        testID="settings-screen"
        className="flex-1 px-5"
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 48 }}
        showsVerticalScrollIndicator={false}
      >
        <ConnectionPill mode={mode} busy={discovering} onPress={() => rediscover().catch(() => {})} />
        <Display className="mt-5">Settings</Display>

        <View className="mt-8">
          <Label>Connection</Label>
          <Card className="mt-3">
            <Row label="Account" value={accountLabel(email)} />
            <Row label="Desktop" value={current?.desktopName ?? "—"} />
            <Row
              label="Path"
              value={serverUrl ? serverUrl.replace(/^https?:\/\//, "") : "Not connected"}
            />
            <Row
              label="This phone"
              value={
                paired
                  ? (current?.device?.name ?? "Paired")
                  : settings.isError && isNotBuiltYet(settings.error)
                    ? "Not paired — this Mac has no PIN yet"
                    : "Not paired"
              }
              last
            />
          </Card>
        </View>

        {settings.isLoading ? <Loading /> : null}
        {settings.isError ? (
          <View className="mt-4">
            <Notice testID="settings-error">
              {desktopErrorMessage(
                settings.error,
                "I can't read your Mac's settings right now, so I'm not going to guess at them."
              )}
            </Notice>
          </View>
        ) : null}

        {current ? (
          <>
            <View className="mt-8">
              <Label>Privacy mode</Label>
              <Text className="mt-1.5 text-xs leading-5 text-faint">
                Set on your Mac. You can make this stricter from here, but loosening it has to
                happen on the desktop itself.
              </Text>
              <View className="mt-3 space-y-3">
                {PRIVACY.map((option) => {
                  const active = current.privacyMode === option.key;
                  const wouldLoosen = option.rank > currentRank;
                  return (
                    <Pressable
                      key={option.key}
                      testID={`privacy-${option.key}`}
                      disabled={active || wouldLoosen || updatePrivacy.isPending}
                      onPress={() => updatePrivacy.mutate(option.key)}
                      className={cn("active:opacity-70", wouldLoosen && "opacity-40")}
                    >
                      <Card className={cn(active && "border-brass bg-brass/10")}>
                        <View className="flex-row items-center justify-between">
                          <Text className={cn("text-base", active ? "text-brass" : "text-bone")}>
                            {option.title}
                          </Text>
                          {active ? <Check color="#D8A54A" size={16} /> : null}
                          {wouldLoosen ? <Lock color="#5F656F" size={14} /> : null}
                        </View>
                        <Text className="mt-1.5 text-xs leading-5 text-faint">{option.detail}</Text>
                        {wouldLoosen ? (
                          <Text className="mt-2 text-xs text-faint">
                            Change this on your Mac.
                          </Text>
                        ) : null}
                      </Card>
                    </Pressable>
                  );
                })}
              </View>
              {updatePrivacy.isError ? (
                <View className="mt-3">
                  <Notice testID="privacy-error">
                    Your Mac refused that change. Privacy can only be relaxed at the desktop.
                  </Notice>
                </View>
              ) : null}
            </View>

            <View className="mt-8">
              <Label>Voice</Label>
              <Card className="mt-3">
                <Row
                  label="Mode"
                  value={current.voiceMode === "unified" ? "Unified model" : "Cascaded pipeline"}
                />
                <Row label="Memory provider" value={current.activeMemoryProvider} last />
              </Card>
              {current.providerSelectorsLocked ? (
                <Text className="mt-2 text-xs leading-5 text-faint">
                  Your Mac is running a unified voice model, so the individual speech and language
                  pickers don't apply.
                </Text>
              ) : null}
            </View>

            <View className="mt-8">
              <Label>Daily Brief</Label>
              <Text className="mt-1.5 text-xs leading-5 text-faint">
                Markets, launches, news sources, and which calendars feed the Brief tab.
              </Text>
              <Pressable
                testID="open-brief-prefs"
                onPress={() => setBriefPrefsOpen(true)}
                className="mt-3 active:opacity-70"
              >
                <Card>
                  <Text className="text-base text-bone">Brief preferences</Text>
                  <Text className="mt-1 text-xs text-faint">Edit what shows up in Brief</Text>
                </Card>
              </Pressable>
            </View>

            <View className="mt-8">
              <Label>Memory health</Label>
              <View className="mt-3 space-y-3">
                <Button
                  testID="verify-memory"
                  variant="ghost"
                  label="Check for problems"
                  loading={verify.isPending}
                  onPress={() => verify.mutate()}
                />
                {verify.data ? (
                  <Animated.View entering={FadeIn}>
                    <Card testID="verify-result">
                      <Text className={verify.data.ok ? "text-sm text-ok" : "text-sm text-warn"}>
                        {verify.data.ok
                          ? "Everything checks out."
                          : `${verify.data.problems.length} problem${verify.data.problems.length === 1 ? "" : "s"} found.`}
                      </Text>
                      <Text className="mt-2 text-xs text-faint">
                        {verify.data.checked.memories} memories · {verify.data.checked.assertions}{" "}
                        claims · {verify.data.checked.artifacts} files
                      </Text>
                      {verify.data.problems.slice(0, 5).map((problem) => (
                        <Text key={problem.id} className="mt-2 text-xs text-warn">
                          {problem.detail}
                        </Text>
                      ))}
                    </Card>
                  </Animated.View>
                ) : null}
                <Button
                  testID="rebuild-indexes"
                  variant="ghost"
                  label="Rebuild the index"
                  loading={rebuild.isPending}
                  onPress={() => rebuild.mutate()}
                />
                {rebuild.data ? (
                  <Text className="text-xs text-faint" testID="rebuild-result">
                    Reindexed {rebuild.data.indexed.memories} memories and pruned{" "}
                    {rebuild.data.prunedReferences} dangling references.
                  </Text>
                ) : null}
              </View>
            </View>
          </>
        ) : null}

        {/* §11.3. Outside the `current` block on purpose: this is the section
            you most want to reach when the Mac *isn't* answering. */}
        <View className="mt-8">
          <Label>Copy on this phone</Label>
          <Text className="mt-1.5 text-xs leading-5 text-faint">
            So you can look things up when your Mac is out of reach. It's a read copy of what
            you've already been shown — your Mac stays the original, and nothing new is
            remembered here.
          </Text>

          <Pressable
            testID="toggle-mirror"
            onPress={async () => {
              const next = !mirrorEnabled;
              await useMirror.getState().setEnabled(next);
              // Switched on, start with a full copy rather than an empty one.
              if (next) syncMirror({ force: true }).catch(() => {});
            }}
            className="mt-3 active:opacity-70"
          >
            <Card className={cn(mirrorEnabled && "border-brass/40")}>
              <View className="flex-row items-center justify-between">
                <Text className={cn("text-base", mirrorEnabled ? "text-brass" : "text-bone")}>
                  {mirrorEnabled ? "Keeping a copy" : "Not keeping a copy"}
                </Text>
                {mirrorEnabled ? <Check color="#D8A54A" size={16} /> : null}
              </View>
              <Text className="mt-1.5 text-xs leading-5 text-faint">
                {mirrorEnabled
                  ? `${mirrorCount} record${mirrorCount === 1 ? "" : "s"} held here. ${describeCopy(mirrorSyncedAt)}`
                  : "Recall will need your Mac. Away from it, this phone will have nothing to show you."}
              </Text>
            </Card>
          </Pressable>

          {mirrorEnabled ? (
            <View className="mt-3">
              <Button
                testID="sync-mirror"
                variant="ghost"
                label="Update the copy now"
                loading={mirrorSyncing}
                disabled={!connected || mirrorSyncing}
                onPress={() => syncMirror({ force: true }).catch(() => {})}
              />
              <Text className="mt-2 text-xs leading-5 text-faint">
                {connected
                  ? "Asks your Mac for everything recent and anything due, so it's here before you need it."
                  : "Your Mac isn't reachable, so there's nothing new to copy down yet."}
              </Text>
            </View>
          ) : null}

          {mirrorEnabled && mirrorCount > 0 ? (
            <View className="mt-3">
              <Button
                testID="clear-mirror"
                variant="ghost"
                label="Remove the copy now"
                onPress={() => useMirror.getState().clear()}
              />
              <Text className="mt-2 text-xs leading-5 text-faint">
                This only clears what's on the phone. It rebuilds as you use Alfred, and your
                Mac is untouched either way.
              </Text>
            </View>
          ) : null}
        </View>

        <View className="mt-10">
          <Label>AlfredBot</Label>
          {robotClaimed ? (
            <View className="mt-3 space-y-3">
              <Pressable
                testID="talk-mode-phone"
                disabled={talkModeBusy}
                onPress={async () => {
                  setTalkModeBusy(true);
                  try {
                    await setRobotTalkEnabled(false);
                    setRobotTalk(false);
                  } finally {
                    setTalkModeBusy(false);
                  }
                }}
                className="active:opacity-70"
              >
                <Card className={cn(!robotTalk && "border-brass/40")}>
                  <View className="flex-row items-center justify-between">
                    <Text className={cn("text-base", !robotTalk ? "text-brass" : "text-bone")}>
                      This phone only
                    </Text>
                    {!robotTalk ? <Check color="#D8A54A" size={16} /> : null}
                  </View>
                  <Text className="mt-1.5 text-xs leading-5 text-faint">
                    Talk on this iPhone. AlfredBot does not need to be online. Start a new Talk
                    after changing this.
                  </Text>
                </Card>
              </Pressable>
              <Pressable
                testID="talk-mode-robot"
                disabled={talkModeBusy}
                onPress={async () => {
                  setTalkModeBusy(true);
                  try {
                    await setRobotTalkEnabled(true);
                    setRobotTalk(true);
                  } finally {
                    setTalkModeBusy(false);
                  }
                }}
                className="active:opacity-70"
              >
                <Card className={cn(robotTalk && "border-brass/40")}>
                  <View className="flex-row items-center justify-between">
                    <Text className={cn("text-base", robotTalk ? "text-brass" : "text-bone")}>
                      Include AlfredBot
                    </Text>
                    {robotTalk ? <Check color="#D8A54A" size={16} /> : null}
                  </View>
                  <Text className="mt-1.5 text-xs leading-5 text-faint">
                    Join AlfredBot's room so he can listen and speak. He must be online. Start a
                    new Talk after changing this.
                  </Text>
                </Card>
              </Pressable>
              {robotTalk ? (
                <>
                  <Pressable
                    testID="talk-audio-phone"
                    disabled={audioRouteBusy}
                    onPress={async () => {
                      setAudioRouteBusy(true);
                      setAudioRouteError(null);
                      try {
                        await setTalkAudioRoute("phone");
                        setRobotAudio(true);
                      } catch (err) {
                        setAudioRouteError(err instanceof Error ? err.message : String(err));
                      } finally {
                        setAudioRouteBusy(false);
                      }
                    }}
                    className="active:opacity-70"
                  >
                    <Card className={cn(robotAudio && "border-brass/40")}>
                      <View className="flex-row items-center justify-between">
                        <Text className={cn("text-base", robotAudio ? "text-brass" : "text-bone")}>
                          Hear him on this iPhone
                        </Text>
                        {robotAudio ? <Check color="#D8A54A" size={16} /> : null}
                      </View>
                      <Text className="mt-1.5 text-xs leading-5 text-faint">
                        This phone is his microphone and speaker. AlfredBot's own audio stays off.
                      </Text>
                    </Card>
                  </Pressable>
                  <Pressable
                    testID="talk-audio-robot"
                    disabled={audioRouteBusy}
                    onPress={async () => {
                      setAudioRouteBusy(true);
                      setAudioRouteError(null);
                      try {
                        await setTalkAudioRoute("robot");
                        setRobotAudio(false);
                      } catch (err) {
                        setAudioRouteError(err instanceof Error ? err.message : String(err));
                      } finally {
                        setAudioRouteBusy(false);
                      }
                    }}
                    className="active:opacity-70"
                  >
                    <Card className={cn(!robotAudio && "border-brass/40")}>
                      <View className="flex-row items-center justify-between">
                        <Text className={cn("text-base", !robotAudio ? "text-brass" : "text-bone")}>
                          Hear him on AlfredBot
                        </Text>
                        {!robotAudio ? <Check color="#D8A54A" size={16} /> : null}
                      </View>
                      <Text className="mt-1.5 text-xs leading-5 text-faint">
                        The robot uses his own mic and speakers. This phone is Start / Stop and
                        captions. Start a new Talk after changing this.
                      </Text>
                    </Card>
                  </Pressable>
                  {audioRouteError ? (
                    <Text className="text-xs leading-5 text-rose-300">{audioRouteError}</Text>
                  ) : null}
                </>
              ) : null}
            </View>
          ) : (
            <Text className="mt-3 text-xs leading-5 text-faint">
              Claim AlfredBot to include him in Talk, or keep talking on this phone alone.
            </Text>
          )}
          <Button
            testID="claim-alfredbot"
            className="mt-3"
            variant="ghost"
            label="Claim AlfredBot"
            onPress={() => router.push("/claim-bot" as Href)}
          />
        </View>

        <View className="mt-10">
          <Label>This device</Label>
          <View className="mt-3 space-y-3">
            <Button
              testID="link-another-mac"
              variant="ghost"
              label="Scan a Mac's code"
              onPress={() => router.push("/(onboarding)/claim")}
            />
            <Button
              testID="unpair-device"
              variant="ghost"
              label="Unpair this phone"
              onPress={() => setConfirm("unpair")}
            />
            <Button
              testID="unlink-desktop"
              variant="ghost"
              label="Unlink this Mac"
              onPress={() => setConfirm("unlink")}
            />
            <Button
              testID="sign-out"
              variant="danger"
              label="Start over on this phone"
              onPress={() => setConfirm("reset")}
            />
          </View>
          <Text className="mt-4 text-xs leading-5 text-faint">
            Your memory lives on your Mac. Nothing you do here deletes any of it — this only
            removes this phone's access.
            {storageIsSecure ? "" : " Note: this preview stores credentials in ordinary storage, not the Keychain."}
          </Text>
        </View>
      </ScrollView>

      <Sheet
        testID="brief-prefs-sheet"
        visible={briefPrefsOpen}
        title="Brief preferences"
        onClose={() => setBriefPrefsOpen(false)}
      >
        {briefPrefs.isLoading ? <Loading /> : null}
        {briefPrefs.isError ? (
          <Notice>
            {desktopErrorMessage(briefPrefs.error, "Couldn't load Brief preferences.")}
          </Notice>
        ) : null}
        {briefPrefs.data ? (
          <BriefPrefsEditor
            prefs={briefPrefs.data.prefs}
            catalog={briefPrefs.data.catalog}
            busy={saveBriefPrefs.isPending}
            onSave={(patch) => saveBriefPrefs.mutate(patch)}
          />
        ) : null}
      </Sheet>

      <Sheet
        testID="leave-sheet"
        visible={confirm !== null}
        title={
          confirm === "unpair"
            ? "Unpair this phone?"
            : confirm === "unlink"
              ? "Unlink this Mac?"
              : "Start over?"
        }
        onClose={() => setConfirm(null)}
      >
        <Text className="text-sm leading-6 text-muted">
          {confirm === "unpair"
            ? "This phone will forget its key to your Mac. You'll pair again with a new PIN. Your memory is untouched."
            : confirm === "unlink"
              ? "Your account will release this Mac and every paired device loses access. The desktop keeps all your memory and will print a fresh claim secret."
              : "This phone releases your Mac and forgets everything it knows about it. You'll scan the code again to come back. Everything on your Mac stays exactly as it is."}
        </Text>
        <View className="mt-6 space-y-3 pb-4">
          <Button
            testID="confirm-leave"
            variant="danger"
            label={confirm === "unpair" ? "Unpair" : confirm === "unlink" ? "Unlink" : "Start over"}
            loading={leave.isPending}
            onPress={() => confirm && leave.mutate(confirm)}
          />
          <Button
            testID="cancel-leave"
            variant="ghost"
            label="Keep things as they are"
            onPress={() => setConfirm(null)}
          />
        </View>
      </Sheet>
    </Backdrop>
  );
}

/**
 * Linking a Mac doesn't ask for an account, so most people have one they never
 * chose — showing its generated address would be noise. Only a real alfrd.net
 * sign-in is worth naming.
 */
function accountLabel(email: string | null): string {
  if (!email || email.endsWith("@device.alfrd.net")) return "This phone";
  return email;
}

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View
      className={cn(
        "flex-row items-center justify-between py-2.5",
        !last && "border-b border-line/60"
      )}
    >
      <Text className="text-sm text-faint">{label}</Text>
      <Text numberOfLines={1} className="ml-4 flex-1 text-right text-sm text-bone">
        {value}
      </Text>
    </View>
  );
}

function BriefPrefsEditor({
  prefs,
  catalog,
  busy,
  onSave,
}: {
  prefs: BriefingPrefs;
  catalog: BriefingPrefsCatalog;
  busy: boolean;
  onSave: (patch: Partial<BriefingPrefs>) => void;
}) {
  const toggleNews = (source: string) => {
    const has = prefs.newsSources.includes(source);
    const newsSources = has
      ? prefs.newsSources.filter((s) => s !== source)
      : [...prefs.newsSources, source].slice(0, 10);
    onSave({ newsSources });
  };

  const toggleCalendar = (id: string) => {
    const has = prefs.agendaCalendarIds.includes(id);
    const agendaCalendarIds = has
      ? prefs.agendaCalendarIds.filter((c) => c !== id)
      : [...prefs.agendaCalendarIds, id].slice(0, 40);
    onSave({ agendaCalendarIds });
  };

  return (
    <View testID="brief-prefs-editor" className="pb-6">
      <Label>Launches</Label>
      <View className="mt-2 flex-row flex-wrap gap-2">
        {catalog.launchesModes.map((mode) => {
          const active = prefs.launchesMode === mode.id;
          return (
            <Pressable
              key={mode.id}
              disabled={busy}
              onPress={() => onSave({ launchesMode: mode.id as BriefingPrefs["launchesMode"] })}
              className={cn(
                "rounded-full border px-3 py-1.5",
                active ? "border-brass/50 bg-brass/15" : "border-line"
              )}
            >
              <Text className={cn("text-xs", active ? "text-brass" : "text-muted")}>{mode.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <Label className="mt-5">Markets</Label>
      <View className="mt-2 space-y-2">
        <Pressable
          disabled={busy}
          onPress={() => onSave({ includeCrypto: !prefs.includeCrypto })}
          className="flex-row items-center justify-between rounded-2xl border border-line px-3 py-3"
        >
          <Text className="text-sm text-bone">Crypto</Text>
          <Text className="text-xs text-brass">{prefs.includeCrypto ? "On" : "Off"}</Text>
        </Pressable>
        <Pressable
          disabled={busy}
          onPress={() => onSave({ includeMetals: !prefs.includeMetals })}
          className="flex-row items-center justify-between rounded-2xl border border-line px-3 py-3"
        >
          <Text className="text-sm text-bone">Metals</Text>
          <Text className="text-xs text-brass">{prefs.includeMetals ? "On" : "Off"}</Text>
        </Pressable>
        <Pressable
          disabled={busy}
          onPress={() => onSave({ includeIngestedNotes: !prefs.includeIngestedNotes })}
          className="flex-row items-center justify-between rounded-2xl border border-line px-3 py-3"
        >
          <Text className="text-sm text-bone">Ingested notes</Text>
          <Text className="text-xs text-brass">{prefs.includeIngestedNotes ? "On" : "Off"}</Text>
        </Pressable>
      </View>

      <Label className="mt-5">News sources</Label>
      <View className="mt-2 flex-row flex-wrap gap-2">
        {catalog.newsSources.slice(0, 12).map((source) => {
          const active = prefs.newsSources.includes(source);
          return (
            <Pressable
              key={source}
              disabled={busy}
              onPress={() => toggleNews(source)}
              className={cn(
                "rounded-full border px-3 py-1.5",
                active ? "border-brass/50 bg-brass/15" : "border-line"
              )}
            >
              <Text className={cn("text-xs", active ? "text-brass" : "text-muted")}>{source}</Text>
            </Pressable>
          );
        })}
      </View>

      <Label className="mt-5">Agenda calendars in Brief</Label>
      <Text className="mt-1 text-xs text-faint">Events from these calendars appear in Daily Brief.</Text>
      <View className="mt-2 space-y-2">
        {catalog.calendars.length === 0 ? (
          <Text className="text-sm text-muted">No readable calendars yet — set Gateway access on the Mac.</Text>
        ) : (
          catalog.calendars.map((cal) => {
            const active = prefs.agendaCalendarIds.includes(cal.id);
            return (
              <Pressable
                key={cal.id}
                disabled={busy}
                onPress={() => toggleCalendar(cal.id)}
                className={cn(
                  "rounded-2xl border px-3 py-2.5",
                  active ? "border-brass/50 bg-brass/10" : "border-line"
                )}
              >
                <Text className={cn("text-sm", active ? "text-brass" : "text-bone")}>{cal.label}</Text>
              </Pressable>
            );
          })
        )}
      </View>
    </View>
  );
}
