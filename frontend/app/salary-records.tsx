import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { api, SalaryRow } from "@/src/lib/api";
import { colors, radius } from "@/src/theme/colors";
import { Avatar } from "@/src/components/Avatar";

const MONTHS = ["Oct 25", "Nov 25", "Dec 25", "Jan 26", "Feb 26"];

const STATUS_META: Record<
  SalaryRow["status"],
  { bg: string; fg: string }
> = {
  Paid: { bg: colors.successSoft, fg: colors.success },
  Pending: { bg: colors.warningSoft, fg: "#B45309" },
  Processing: { bg: colors.infoSoft, fg: colors.info },
};

export default function SalaryRecords() {
  const router = useRouter();
  const [month, setMonth] = useState("Feb 26");
  const [rows, setRows] = useState<SalaryRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    try {
      const data = await api.salary(m);
      setRows(data);
    } catch (e) {
      console.warn("salary load failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(month);
    }, [load, month])
  );

  useEffect(() => {
    load(month);
  }, [month, load]);

  const totalPayout = rows.reduce((s, r) => s + r.net, 0);
  const paid = rows.filter((r) => r.status === "Paid").length;

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={[colors.primary, "#1E293B"]}
        style={styles.headerBg}
      >
        <SafeAreaView edges={["top"]} style={{ paddingHorizontal: 16 }}>
          <View style={styles.headerRow}>
            <Pressable
              onPress={() => router.back()}
              style={styles.iconBtn}
              testID="salary-back-button"
              hitSlop={10}
            >
              <Ionicons name="chevron-back" size={22} color={colors.white} />
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Salary Records</Text>
              <Text style={styles.subtitle}>Monthly payroll overview</Text>
            </View>
            <Pressable style={styles.iconBtn} testID="salary-export-button">
              <Ionicons
                name="download-outline"
                size={20}
                color={colors.white}
              />
            </Pressable>
          </View>

          <View style={styles.summary}>
            <View style={{ flex: 1 }}>
              <Text style={styles.summaryLabel}>Total payout · {month}</Text>
              <Text style={styles.summaryValue}>
                ₹ {totalPayout.toLocaleString("en-IN")}
              </Text>
              <View style={styles.summaryMetaRow}>
                <View style={styles.summaryMetaItem}>
                  <View style={[styles.smallDot, { backgroundColor: colors.success }]} />
                  <Text style={styles.summaryMetaText}>
                    {paid} Paid
                  </Text>
                </View>
                <View style={styles.summaryMetaItem}>
                  <View style={[styles.smallDot, { backgroundColor: "#FBBF24" }]} />
                  <Text style={styles.summaryMetaText}>
                    {rows.length - paid} Pending
                  </Text>
                </View>
              </View>
            </View>
            <View style={styles.summaryIcon}>
              <Ionicons name="wallet" size={26} color={colors.white} />
            </View>
          </View>
        </SafeAreaView>
      </LinearGradient>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.monthRow}
      >
        {MONTHS.map((m) => {
          const active = m === month;
          return (
            <Pressable
              key={m}
              onPress={() => setMonth(m)}
              testID={`month-${m.toLowerCase().replace(/\s+/g, "-")}`}
              style={[styles.monthChip, active && styles.monthChipActive]}
            >
              <Text
                style={[
                  styles.monthChipText,
                  active && { color: colors.white },
                ]}
              >
                {m}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <View style={{ paddingVertical: 60, alignItems: "center" }}>
            <ActivityIndicator color={colors.brand} />
            <Text style={{ marginTop: 12, color: colors.textMuted, fontSize: 13 }}>
              Loading salary…
            </Text>
          </View>
        ) : rows.length === 0 ? (
          <View style={{ paddingVertical: 60, alignItems: "center" }}>
            <Ionicons name="wallet-outline" size={36} color={colors.textMuted} />
            <Text style={{ marginTop: 12, color: colors.textMuted, fontSize: 13 }}>
              No salary records for {month}
            </Text>
          </View>
        ) : (
          rows.map((r) => {
            const meta = STATUS_META[r.status];
            return (
              <View key={r.id} style={styles.card}>
                <View style={styles.cardTop}>
                  <Avatar photo={r.photo} name={r.name} size={44} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.empName}>{r.employee_name}</Text>
                    <Text style={styles.empCode}>{r.employee_code}</Text>
                  </View>
                  <View style={[styles.statusPill, { backgroundColor: meta.bg }]}>
                    <Text style={[styles.statusText, { color: meta.fg }]}>
                      {r.status}
                    </Text>
                  </View>
                </View>

                <View style={styles.metaRow}>
                  <Meta label="Days" value={`${r.days_worked}`} />
                  <View style={styles.metaSep} />
                  <Meta label="Rate/Day" value={`₹${r.daily_rate}`} />
                  <View style={styles.metaSep} />
                  <Meta
                    label="Deduct"
                    value={`₹${r.deductions}`}
                    color={r.deductions > 0 ? colors.danger : undefined}
                  />
                </View>

                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Net payable</Text>
                  <Text style={styles.totalValue}>
                    ₹ {r.net.toLocaleString("en-IN")}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

function Meta({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <View style={{ alignItems: "center", flex: 1 }}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={[styles.metaValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  headerBg: {
    paddingBottom: 24,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingTop: 8,
    paddingBottom: 12,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
    color: colors.white,
    letterSpacing: -0.4,
  },
  subtitle: { fontSize: 12, color: "#CBD5E1", marginTop: 2 },

  summary: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(255,255,255,0.12)",
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: 16,
    marginTop: 8,
  },
  summaryLabel: { color: "#94A3B8", fontSize: 12, fontWeight: "600" },
  summaryValue: {
    color: colors.white,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.6,
    marginTop: 4,
  },
  summaryMetaRow: { flexDirection: "row", gap: 14, marginTop: 8 },
  summaryMetaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  smallDot: { width: 8, height: 8, borderRadius: 999 },
  summaryMetaText: { color: "#E2E8F0", fontSize: 12, fontWeight: "600" },
  summaryIcon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },

  monthRow: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 46, gap: 8 },
  monthChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 999,
    height: 36,
    justifyContent: "center",
    flexShrink: 0,
  },
  monthChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  monthChipText: { fontSize: 13, fontWeight: "700", color: colors.textPrimary },

  list: { paddingHorizontal: 20, paddingTop: 0, paddingBottom: 32, gap: 10 },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 10,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  avatar: { width: 44, height: 44, borderRadius: 999 },
  empName: { fontSize: 14, fontWeight: "700", color: colors.textPrimary },
  empCode: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  statusText: { fontSize: 10, fontWeight: "700" },

  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 14,
    paddingVertical: 10,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
  },
  metaSep: { width: 1, height: 24, backgroundColor: colors.border },
  metaLabel: {
    fontSize: 10,
    color: colors.textMuted,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  metaValue: {
    fontSize: 14,
    fontWeight: "800",
    color: colors.textPrimary,
    marginTop: 2,
  },

  totalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  totalLabel: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: "600",
  },
  totalValue: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.success,
    letterSpacing: -0.4,
  },
});
