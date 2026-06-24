import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000/api';

export const api = axios.create({ baseURL: BASE_URL });

// Attach JWT to every request
api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('auth_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto logout on 401
api.interceptors.response.use(
  r => r,
  async err => {
    if (err.response?.status === 401) {
      await SecureStore.deleteItemAsync('auth_token');
    }
    return Promise.reject(err);
  }
);

// API methods
export const authApi = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  register: (name: string, email: string, password: string, role: string) =>
    api.post('/auth/register', { name, email, password, role }),
  savePushToken: (expoPushToken: string) =>
    api.patch('/auth/push-token', { expoPushToken }),
};

export const conferencesApi = {
  list: () => api.get('/conferences'),
  get: (id: string) => api.get(`/conferences/${id}`),
  create: (title: string, description?: string) =>
    api.post('/conferences', { title, description }),
  end: (id: string) => api.patch(`/conferences/${id}/end`),
  getLiveKitToken: (id: string) => api.post(`/conferences/${id}/livekit-token`),
  join: (id: string) => api.patch(`/conferences/${id}/participants/join`),
};

export const participantsApi = {
  add: (conferenceId: string, userId: string, role: string, settings?: any) =>
    api.post(`/conferences/${conferenceId}/participants`, { userId, role, ...settings }),
  remove: (conferenceId: string, userId: string) =>
    api.delete(`/conferences/${conferenceId}/participants/${userId}`),
};

export const usersApi = {
  list: () => api.get('/users'),
};
