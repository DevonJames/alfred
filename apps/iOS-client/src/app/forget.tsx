/**
 * Scoped forget (§11.1.5).
 *
 * "Forget" is never one thing. Dropping a photo is not the same as dropping
 * what you learned from it, which is not the same as dropping a person. Each
 * scope states exactly what survives, because a wrong guess here is permanent.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Backdrop, Button, Card, Display, Label, Loading, Notice } from "@/components/ui";
import { cn } from "@/lib/cn";
import { forgetMemory, getEpisode } from "@/lib/desktop-api";
import { useMirror } from "@/lib/memory-cache";
import type { ForgetScope } from "@/lib/types";

const SCOPES: { key: ForgetScope; title: string; detail: string }[] = [
  {
    key: "artifact",
    title: "Just the files",
    detail: "The photos and documents are deleted. What I learned from them stays, and I'll mark it as no longer having a source.",
  },
  {
    key: "extracted",
    title: "What I concluded",
    detail: "I drop the claims I extracted but keep the original note and files exactly as you gave them.",
  },
  {
    key: "episode",
    title: "This moment",
    detail: "The whole entry goes — note, claims and files. People and places mentioned in it stay, since they exist elsewhere too.",
  },
  {
    key: "entity",
    title: "This person or thing",
    detail: "Removes the entity itself. Moments that mentioned it stay, but they'll no longer link to it.",
  },
  {
    key: "subgraph",
    title: "This and everything hanging off it",
    detail: "The entry and everything connected only to it. The widest scope — nothing else references what's removed.",
  },
];

export default function Forget() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<ForgetScope | null>(null);
  const [confirming, setConfirming] = useState(false);

  const memory = useQuery({
    queryKey: ["memory", id],
    queryFn: () => getEpisode(id),
    enabled: Boolean(id),
  });

  const submit = useMutation({
    mutationFn: () => forgetMemory(id, scope!),
    onSuccess: () => {
      // Forgetting has to reach the copy on this phone as well, or the thing the
      // user just removed would still be readable offline.
      //
      // A subgraph forget takes out records this screen never names, and the
      // phone can't know which. So it drops the whole copy and lets it rebuild
      // from the Mac — over-deleting a cache is recoverable; keeping something
      // the user asked to be rid of is not.
      if (scope === "subgraph") useMirror.getState().clear().catch(() => {});
      else useMirror.getState().drop([id]);
      queryClient.invalidateQueries({ queryKey: ["memory"] });
    },
  });

  const pkg = memory.data?.memory;
  const chosen = SCOPES.find((s) => s.key === scope);
  const done = submit.data;

  return (
    <Backdrop>
      <View className="flex-1 px-5" style={{ paddingTop: 16, paddingBottom: insets.bottom + 16 }}>
        <View className="flex-row items-center justify-between">
          <Label>Forget</Label>
          <Pressable
            testID="close-forget"
            onPress={() => router.back()}
            className="h-9 w-9 items-center justify-center rounded-full active:opacity-60"
          >
            <X color="#8D939E" size={18} />
          </Pressable>
        </View>

        {done ? (
          <Animated.View entering={FadeIn} className="flex-1 justify-center" testID="forget-done">
            <Display className="text-center">Forgotten.</Display>
            <Text className="mt-4 text-center text-sm leading-5 text-muted">
              {Object.entries(done.removed)
                .filter(([, count]) => count > 0)
                .map(([what, count]) => `${count} ${what}`)
                .join(", ") || "Nothing was left to remove"}
              .
            </Text>
            {done.kept.length > 0 ? (
              <Card className="mt-6">
                <Label>Deliberately kept</Label>
                {done.kept.map((item) => (
                  <Text key={item} className="mt-2 text-sm text-muted">
                    {item}
                  </Text>
                ))}
              </Card>
            ) : null}
            <Button
              testID="forget-close"
              className="mt-10"
              label="Done"
              onPress={() => {
                router.back();
                router.back();
              }}
            />
          </Animated.View>
        ) : (
          <>
            <ScrollView className="mt-4 flex-1" showsVerticalScrollIndicator={false}>
              {memory.isLoading ? <Loading /> : null}
              {pkg ? <Display className="text-3xl">{pkg.title}</Display> : null}

              <Text className="mt-3 text-sm leading-5 text-muted">
                Tell me how much to let go of. I'll only do exactly what you pick.
              </Text>

              <View className="mt-6 space-y-3">
                {SCOPES.map((option) => (
                  <Pressable
                    key={option.key}
                    testID={`scope-${option.key}`}
                    onPress={() => {
                      setScope(option.key);
                      setConfirming(false);
                    }}
                    className="active:opacity-70"
                  >
                    <Card className={cn(scope === option.key && "border-live/50 bg-live/5")}>
                      <Text
                        className={cn(
                          "text-base",
                          scope === option.key ? "text-live" : "text-bone"
                        )}
                      >
                        {option.title}
                      </Text>
                      <Text className="mt-1.5 text-xs leading-5 text-faint">{option.detail}</Text>
                    </Card>
                  </Pressable>
                ))}
              </View>

              {submit.isError ? (
                <View className="mt-4">
                  <Notice testID="forget-error">
                    I couldn't reach your Mac. Nothing was removed.
                  </Notice>
                </View>
              ) : null}
            </ScrollView>

            {confirming && chosen ? (
              <Animated.View entering={FadeIn} className="mb-3" testID="forget-confirm">
                <Notice tone="error">
                  This can't be undone. {chosen.detail}
                </Notice>
              </Animated.View>
            ) : null}

            <Button
              testID="submit-forget"
              variant="danger"
              label={confirming ? "Yes, forget it" : "Forget"}
              disabled={!scope}
              loading={submit.isPending}
              onPress={() => (confirming ? submit.mutate() : setConfirming(true))}
            />
          </>
        )}
      </View>
    </Backdrop>
  );
}
