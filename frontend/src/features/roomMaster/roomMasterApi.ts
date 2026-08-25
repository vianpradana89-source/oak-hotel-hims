import {
  type ApiEnvelope,
  type PhysicalRoom,
  type PhysicalRoomWritePayload,
  type RoomType,
  type RoomTypeWritePayload,
  RoomMasterApiError
} from './roomMasterTypes';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (err) {
    throw new RoomMasterApiError(
      err instanceof Error ? err.message : 'network error',
      'NETWORK_ERROR',
      0
    );
  }

  let body: ApiEnvelope<T> | null = null;
  try {
    body = (await response.json()) as ApiEnvelope<T>;
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new RoomMasterApiError(
      body?.message || `permintaan gagal (HTTP ${response.status})`,
      body?.code || 'UNKNOWN_ERROR',
      response.status
    );
  }
  if (!body) {
    throw new RoomMasterApiError('respons server tidak valid', 'UNKNOWN_ERROR', response.status);
  }
  if (body.status === 'ERROR' || body.status === 'CONFLICT') {
    throw new RoomMasterApiError(body.message || 'permintaan gagal', body.code || 'UNKNOWN_ERROR', response.status);
  }
  return body.data as T;
}

function jsonInit(method: string, payload: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

export const roomMasterApi = {
  async listRoomTypes(active?: boolean): Promise<RoomType[]> {
    const suffix = active === undefined ? '' : `?active=${active}`;
    return request<RoomType[]>(`/api/room-types${suffix}`);
  },

  async createRoomType(payload: RoomTypeWritePayload): Promise<RoomType> {
    return request<RoomType>('/api/room-types', jsonInit('POST', payload));
  },

  async updateRoomType(id: number, payload: RoomTypeWritePayload & { is_active?: boolean }): Promise<RoomType> {
    return request<RoomType>(`/api/room-types/${id}`, jsonInit('PATCH', payload));
  },

  async listRooms(filter?: { room_type_id?: number; is_active?: boolean }): Promise<PhysicalRoom[]> {
    const params = new URLSearchParams();
    if (filter?.room_type_id !== undefined) params.set('room_type_id', String(filter.room_type_id));
    if (filter?.is_active !== undefined) params.set('is_active', String(filter.is_active));
    const query = params.toString();
    return request<PhysicalRoom[]>(`/api/rooms${query ? `?${query}` : ''}`);
  },

  async createRoom(payload: PhysicalRoomWritePayload): Promise<PhysicalRoom> {
    return request<PhysicalRoom>('/api/rooms', jsonInit('POST', payload));
  },

  async updateRoom(id: number, payload: PhysicalRoomWritePayload): Promise<PhysicalRoom> {
    return request<PhysicalRoom>(`/api/rooms/${id}`, jsonInit('PATCH', payload));
  },

  async deleteRoom(id: number): Promise<void> {
    await request<{ id: number }>(`/api/rooms/${id}`, { method: 'DELETE' });
  },

  async deleteRoomType(id: number): Promise<void> {
    await request<{ id: number }>(`/api/room-types/${id}`, { method: 'DELETE' });
  }
};
