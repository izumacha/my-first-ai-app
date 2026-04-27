/**
 * カテゴリ選択チップコンポーネント
 * ユーザーが質問のカテゴリを選択するためのチップ UI を表示する。
 */
"use client";

import { CATEGORIES } from "@/lib/prompts";
import type { CategoryId } from "@/lib/types";

/** CategoryChips コンポーネントの Props */
interface CategoryChipsProps {
  /** 現在選択されているカテゴリ ID */
  selected: CategoryId;
  /** カテゴリが選択されたときに呼ばれるコールバック関数 */
  onSelect: (categoryId: CategoryId) => void;
}

/**
 * カテゴリ選択チップを横並びで表示するコンポーネント
 * 選択中のカテゴリはハイライト表示する。
 */
export default function CategoryChips({
  selected,
  onSelect,
}: CategoryChipsProps) {
  return (
    // チップを横並びにするコンテナ（横スクロール可能）
    <div className="flex gap-2 overflow-x-auto px-4 py-3 border-b border-gray-200 dark:border-gray-700">
      {/* カテゴリ一覧をループしてチップを表示する */}
      {CATEGORIES.map((category) => (
        <button
          key={category.id}
          onClick={() => onSelect(category.id)}
          title={category.description}
          className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition-colors ${
            // 選択中のカテゴリは青色、それ以外は灰色で表示する
            selected === category.id
              ? "bg-blue-600 text-white"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          }`}
        >
          {/* カテゴリのラベルを表示する */}
          {category.label}
        </button>
      ))}
    </div>
  );
}
