import { create } from 'zustand';

export type ToastKind = 'success' | 'info' | 'warning' | 'error';

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  message: string;
  detail?: string;
  createdAt: number;
  duration: number;
}

export interface ToastInput {
  kind: ToastKind;
  title: string;
  message: string;
  detail?: string;
  duration?: number;
}

interface ToastState {
  toasts: Toast[];
  pushToast: (toast: ToastInput) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

const DEFAULT_TOAST_DURATIONS: Record<ToastKind, number> = {
  success: 3200,
  info: 4200,
  warning: 5600,
  error: 7000,
};

let nextToastId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  pushToast: (toast) => {
    const id = `toast-${Date.now()}-${nextToastId++}`;
    const duration = toast.duration ?? DEFAULT_TOAST_DURATIONS[toast.kind];

    set((state) => ({
      toasts: [
        ...state.toasts,
        {
          id,
          kind: toast.kind,
          title: toast.title,
          message: toast.message,
          detail: toast.detail,
          createdAt: Date.now(),
          duration,
        },
      ],
    }));

    return id;
  },

  dismissToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    })),

  clearToasts: () => set({ toasts: [] }),
}));
