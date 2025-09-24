const baseUrl = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

export const API_BASE_URL = baseUrl.length > 0 ? baseUrl : "";

export const buildApiUrl = (path: string) => `${API_BASE_URL}${path}`;
