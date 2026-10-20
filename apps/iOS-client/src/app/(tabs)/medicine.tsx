/**
 * Medicine & supplements — today's checklist + bottle photos from the phone camera.
 * Photos identify the product; the plan note decides when and how much.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import {
  Camera,
  Check,
  ImagePlus,
  Pill,
  Trash2,
  X,
} from "lucide-react-native";
import { useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Backdrop,
  BRASS,
  Button,
  Card,
  ConnectionPill,
  Display,
  Empty,
  Label,
  Loading,
  Notice,
  Sheet,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { useConnection } from "@/lib/connection";
import {
  analyzeMedicine,
  assetHeaders,
  deleteMedicineItem,
  desktopErrorMessage,
  getMedicineSchedule,
  logMedicine,
  medicineImageUrl,
} from "@/lib/desktop-api";
import { rediscover } from "@/lib/discovery";
import type { MedicineItem, MedicinePeriod } from "@/lib/types";

const PERIODS: Array<{ id: MedicinePeriod; label: string }> = [
  { id: "morning", label: "Morning" },
  { id: "midday", label: "Mid-day" },
  { id: "evening", label: "Evening" },
];

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Attachment {
  uri: string;
  name: string;
  mimeType: string;
}

function daysLabel(days: MedicineItem["days"]): string {
  if (!Array.isArray(days) || days.length === 0 || days.length === 7) return "Every day";
  const set = new Set(days);
  if (set.size === 5 && [1, 2, 3, 4, 5].every((day) => set.has(day))) return "Weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "Weekends";
  return days.map((day) => DAY_LABELS[day] || "").filter(Boolean).join(" ");
}

export default function Medicine() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const mode = useConnection((s) => s.mode);
  const discovering = useConnection((s) => s.discovering);
  const connected = useConnection((s) => Boolean(s.serverUrl && s.deviceToken));

  const [composerOpen, setComposerOpen] = useState(false);
  const [plan, setPlan] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);

  const schedule = useQuery({
    queryKey: ["medicine", "schedule"],
    queryFn: getMedicineSchedule,
    enabled: connected,
  });

  const items = schedule.data?.items ?? [];
  const grouped = useMemo(() => {
    return PERIODS.map((period) => ({
      ...period,
      items: items.filter((item) => item.period === period.id),
    })).filter((group) => group.items.length > 0);
  }, [items]);

  const log = useMutation({
    mutationFn: logMedicine,
    onSuccess: (result) => {
      queryClient.setQueryData(["medicine", "schedule"], {
        dayKey: result.dayKey,
        items: result.items,
      });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteMedicineItem(id),
    onSuccess: (result) => {
      queryClient.setQueryData(["medicine", "schedule"], result);
    },
  });

  const analyze = useMutation({
    mutationFn: () => analyzeMedicine({ plan, files }),
    onSuccess: (result) => {
      queryClient.setQueryData(["medicine", "schedule"], result);
      setComposerOpen(false);
      setPlan("");
      setFiles([]);
      if (result.summary) {
        Alert.alert("Schedule updated", result.summary);
      }
    },
  });

  async function pickFromLibrary() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Photos needed", "Allow photo library access to add bottle pictures.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.85,
      allowsMultipleSelection: true,
      selectionLimit: 8 - files.length,
    });
    if (result.canceled) return;
    setFiles((current) => [
      ...current,
      ...result.assets.map((asset, index) => ({
        uri: asset.uri,
        name: asset.fileName ?? `bottle-${Date.now()}-${index}.jpg`,
        mimeType: asset.mimeType ?? "image/jpeg",
      })),
    ]);
  }

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera needed", "Allow camera access to photograph bottles and labels.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.85,
      allowsEditing: false,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    setFiles((current) => [
      ...current,
      {
        uri: asset.uri,
        name: asset.fileName ?? `bottle-${Date.now()}.jpg`,
        mimeType: asset.mimeType ?? "image/jpeg",
      },
    ]);
  }

  return (
    <Backdrop>
      <ScrollView
        testID="medicine-screen"
        className="flex-1"
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 48 }}
        refreshControl={
          <RefreshControl
            refreshing={schedule.isFetching && !schedule.isLoading}
            onRefresh={() => schedule.refetch()}
            tintColor="#D8A54A"
          />
        }
      >
        <View className="px-5">
          <ConnectionPill mode={mode} busy={discovering} onPress={() => rediscover().catch(() => {})} />
          <View className="mt-5 flex-row items-center justify-between">
            <Display>Medicine</Display>
            <Pressable
              testID="medicine-add"
              disabled={!connected}
              onPress={() => setComposerOpen(true)}
              className="h-10 w-10 items-center justify-center rounded-full border border-brass/40 bg-brass/10 active:opacity-70"
              style={{ opacity: connected ? 1 : 0.35 }}
            >
              <Camera color={BRASS} size={18} />
            </Pressable>
          </View>
          <Text className="mt-2 text-sm text-muted">
            Photos identify the bottle. Your note decides when and how much.
          </Text>
          {schedule.data?.dayKey ? (
            <Text className="mt-1 text-xs text-faint">Today · {schedule.data.dayKey}</Text>
          ) : null}
        </View>

        {!connected ? (
          <View className="mt-8 px-5">
            <Notice>Connect to your Mac to see the medicine schedule.</Notice>
          </View>
        ) : null}

        {schedule.isLoading ? <Loading /> : null}
        {schedule.isError ? (
          <View className="mt-6 px-5">
            <Notice testID="medicine-error">
              {desktopErrorMessage(schedule.error, "Couldn't load the medicine schedule.")}
            </Notice>
          </View>
        ) : null}

        {!schedule.isLoading && connected && items.length === 0 ? (
          <Empty
            testID="medicine-empty"
            title="No schedule yet"
            detail="Photograph bottles and add a short plan — morning, with breakfast, before 10 — to build the list."
          />
        ) : null}

        <View className="mt-6 space-y-6 px-5">
          {grouped.map((group) => (
            <View key={group.id}>
              <View className="mb-3 flex-row items-center justify-between">
                <Label>{group.label}</Label>
                <Pressable
                  testID={`medicine-all-${group.id}`}
                  disabled={log.isPending}
                  onPress={() => log.mutate({ mode: "all", period: group.id })}
                  className="rounded-full border border-line px-3 py-1.5 active:opacity-70"
                >
                  <Text className="text-xs text-brass">Mark all taken</Text>
                </Pressable>
              </View>
              <View className="space-y-3">
                {group.items.map((item, index) => (
                  <MedicineRow
                    key={item.id}
                    item={item}
                    index={index}
                    busy={log.isPending || remove.isPending}
                    onToggle={(taken) =>
                      log.mutate(
                        taken
                          ? { mode: "only", ids: [item.id] }
                          : { mode: "undo", ids: [item.id] }
                      )
                    }
                    onDelete={() =>
                      Alert.alert("Remove from schedule?", item.name, [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Delete",
                          style: "destructive",
                          onPress: () => remove.mutate(item.id),
                        },
                      ])
                    }
                  />
                ))}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      <Sheet
        visible={composerOpen}
        onClose={() => {
          if (analyze.isPending) return;
          setComposerOpen(false);
        }}
        title="Add from photos"
        testID="medicine-composer"
      >
        <Text className="text-sm text-muted">
          Photograph labels, then say when you take them. Alfred does not change a dose.
        </Text>

        <View className="mt-4 flex-row space-x-2">
          <Pressable
            testID="medicine-camera"
            disabled={files.length >= 8 || analyze.isPending}
            onPress={() => void takePhoto()}
            className="flex-1 flex-row items-center justify-center space-x-2 rounded-2xl border border-brass/40 bg-brass/10 px-3 py-3 active:opacity-70"
          >
            <Camera color={BRASS} size={16} />
            <Text className="text-sm text-brass">Camera</Text>
          </Pressable>
          <Pressable
            testID="medicine-library"
            disabled={files.length >= 8 || analyze.isPending}
            onPress={() => void pickFromLibrary()}
            className="flex-1 flex-row items-center justify-center space-x-2 rounded-2xl border border-line px-3 py-3 active:opacity-70"
          >
            <ImagePlus color="#8D939E" size={16} />
            <Text className="text-sm text-muted">Library</Text>
          </Pressable>
        </View>

        {files.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mt-4">
            <View className="flex-row space-x-2">
              {files.map((file) => (
                <View key={file.uri} className="relative">
                  <Image
                    source={{ uri: file.uri }}
                    style={{ width: 72, height: 72, borderRadius: 12 }}
                    contentFit="cover"
                  />
                  <Pressable
                    onPress={() => setFiles((current) => current.filter((f) => f.uri !== file.uri))}
                    className="absolute -right-1 -top-1 h-6 w-6 items-center justify-center rounded-full bg-ink-900"
                  >
                    <X color="#C7CCD6" size={12} />
                  </Pressable>
                </View>
              ))}
            </View>
          </ScrollView>
        ) : (
          <View className="mt-4 items-center rounded-2xl border border-dashed border-line px-4 py-8">
            <Pill color="#5F656F" size={22} />
            <Text className="mt-2 text-sm text-faint">No photos yet</Text>
          </View>
        )}

        <Label className="mt-4">Plan note</Label>
        <TextInput
          testID="medicine-plan"
          value={plan}
          onChangeText={setPlan}
          multiline
          placeholder="Vitamin D and magnesium every morning with breakfast, before 10. Fish oil at mid-day."
          placeholderTextColor="#5F656F"
          className="mt-2 min-h-[96px] rounded-2xl border border-line bg-ink-700 px-4 py-3 text-base text-bone"
          textAlignVertical="top"
        />

        {analyze.isError ? (
          <View className="mt-3">
            <Notice tone="error">
              {desktopErrorMessage(analyze.error, "Couldn't read those bottles. Try again.")}
            </Notice>
          </View>
        ) : null}

        <View className="mt-5">
          <Button
            testID="medicine-analyze"
            label={analyze.isPending ? "Reading labels…" : "Add to schedule"}
            disabled={analyze.isPending || (!plan.trim() && files.length === 0)}
            onPress={() => analyze.mutate()}
          />
        </View>
      </Sheet>
    </Backdrop>
  );
}

function MedicineRow({
  item,
  index,
  busy,
  onToggle,
  onDelete,
}: {
  item: MedicineItem;
  index: number;
  busy: boolean;
  onToggle: (taken: boolean) => void;
  onDelete: () => void;
}) {
  const uri = item.imageId ? medicineImageUrl(item.imageId) : null;
  const meta = [item.quantity, item.instruction, daysLabel(item.days)].filter(Boolean).join(" · ");

  return (
    <Animated.View entering={FadeInDown.delay(index * 40)}>
      <Card testID={`medicine-item-${item.id}`}>
        <View className="flex-row items-start">
          <Switch
            testID={`medicine-taken-${item.id}`}
            value={item.taken}
            disabled={!item.dueToday || busy}
            onValueChange={onToggle}
            trackColor={{ false: "#2E343D", true: "rgba(216,165,74,0.45)" }}
            thumbColor={item.taken ? BRASS : "#8D939E"}
          />
          {uri ? (
            <Image
              source={{ uri, headers: assetHeaders() }}
              style={{ width: 52, height: 52, borderRadius: 10, marginLeft: 10 }}
              contentFit="cover"
            />
          ) : (
            <View className="ml-2.5 h-[52px] w-[52px] items-center justify-center rounded-[10px] border border-line">
              <Pill color="#5F656F" size={18} />
            </View>
          )}
          <View className="ml-3 flex-1">
            <Text className="text-base leading-6 text-bone">{item.name}</Text>
            {meta ? <Text className="mt-1 text-xs text-faint">{meta}</Text> : null}
            {!item.dueToday ? (
              <Text className="mt-1 text-xs text-muted">Not scheduled today</Text>
            ) : item.taken ? (
              <View className="mt-1 flex-row items-center space-x-1">
                <Check color="#5AA97C" size={12} />
                <Text className="text-xs text-ok">Taken</Text>
              </View>
            ) : null}
            {item.needsReview ? (
              <Text className="mt-1 text-xs text-warn">Needs a quick check on dose or name</Text>
            ) : null}
          </View>
          <Pressable
            testID={`medicine-delete-${item.id}`}
            disabled={busy}
            onPress={onDelete}
            className={cn(
              "ml-2 h-9 w-9 items-center justify-center rounded-full border border-line active:opacity-70",
              busy && "opacity-40"
            )}
          >
            <Trash2 color="#E2574C" size={15} />
          </Pressable>
        </View>
      </Card>
    </Animated.View>
  );
}
