import {
  type ActiveRoomReservationDrilldown,
  type ApiEnvelope,
  type PhysicalRoom,
  type PhysicalRoomWritePayload,
  type RoomCategory,
  type RoomCategoryReorderPayload,
  type RoomCategoryWritePayload,
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
  async listRoomCategories(propertyId: number, active?: boolean): Promise<RoomCategory[]> {
    const params = new URLSearchParams();
    params.set('property_id', String(propertyId));
    if (active !== undefined) params.set('active', String(active));
    return request<RoomCategory[]>(`/api/room-categories?${params.toString()}`);
  },

  async createRoomCategory(propertyId: number, payload: RoomCategoryWritePayload): Promise<RoomCategory> {
    return request<RoomCategory>('/api/room-categories', jsonInit('POST', { ...payload, property_id: propertyId }));
  },

  async updateRoomCategory(
    id: number,
    propertyId: number,
    payload: RoomCategoryWritePayload & { is_active?: boolean }
  ): Promise<RoomCategory> {
    return request<RoomCategory>(`/api/room-categories/${id}`, jsonInit('PATCH', { ...payload, property_id: propertyId }));
  },

  async reorderRoomCategories(propertyId: number, payload: RoomCategoryReorderPayload): Promise<RoomCategory[]> {
    return request<RoomCategory[]>('/api/room-categories/reorder', jsonInit('PATCH', { ...payload, property_id: propertyId }));
  },

  async deleteRoomCategory(id: number, propertyId: number): Promise<void> {
    await request<{ id: number }>(`/api/room-categories/${id}?property_id=${propertyId}`, { method: 'DELETE' });
  },

  async listRoomTypes(propertyId: number, active?: boolean): Promise<RoomType[]> {
    const params = new URLSearchParams();
    params.set('property_id', String(propertyId));
    if (active !== undefined) params.set('active', String(active));
    return request<RoomType[]>(`/api/room-types?${params.toString()}`);
  },

  async createRoomType(propertyId: number, payload: RoomTypeWritePayload): Promise<RoomType> {
    return request<RoomType>('/api/room-types', jsonInit('POST', { ...payload, property_id: propertyId }));
  },

  async updateRoomType(id: number, propertyId: number, payload: RoomTypeWritePayload & { is_active?: boolean }): Promise<RoomType> {
    return request<RoomType>(`/api/room-types/${id}`, jsonInit('PATCH', { ...payload, property_id: propertyId }));
  },

  async listRooms(propertyId: number, filter?: { room_type_id?: number; is_active?: boolean }): Promise<PhysicalRoom[]> {
    const params = new URLSearchParams();
    params.set('property_id', String(propertyId));
    if (filter?.room_type_id !== undefined) params.set('room_type_id', String(filter.room_type_id));
    if (filter?.is_active !== undefined) params.set('is_active', String(filter.is_active));
    return request<PhysicalRoom[]>(`/api/rooms?${params.toString()}`);
  },

  async listActiveRoomReservations(roomId: number, propertyId: number): Promise<ActiveRoomReservationDrilldown> {
    const params = new URLSearchParams();
    params.set('property_id', String(propertyId));
    return request<ActiveRoomReservationDrilldown>(`/api/rooms/${roomId}/active-reservations?${params.toString()}`);
  },

  async createRoom(propertyId: number, payload: PhysicalRoomWritePayload): Promise<PhysicalRoom> {
    return request<PhysicalRoom>('/api/rooms', jsonInit('POST', { ...payload, property_id: propertyId }));
  },

  async updateRoom(id: number, propertyId: number, payload: PhysicalRoomWritePayload): Promise<PhysicalRoom> {
    return request<PhysicalRoom>(`/api/rooms/${id}`, jsonInit('PATCH', { ...payload, property_id: propertyId }));
  },

  async deleteRoom(id: number, propertyId: number): Promise<void> {
    await request<{ id: number }>(`/api/rooms/${id}?property_id=${propertyId}`, { method: 'DELETE' });
  },

  async deleteRoomType(id: number, propertyId: number): Promise<void> {
    await request<{ id: number }>(`/api/room-types/${id}?property_id=${propertyId}`, { method: 'DELETE' });
  }
};
