<template>
  <el-form
    ref="formRef"
    :model="data"
    label-width="140px"
    size="small"
    class="hardware"
    :disabled="globalStart"
    hide-required-asterisk
  >
    <el-divider content-position="left">
      {{ i18next.t('uds.hardware.canBridge.sections.bridgeConfig') }}
    </el-divider>

    <el-form-item :label="i18next.t('uds.hardware.canBridge.labels.name')" prop="name" required>
      <el-input v-model="data.name" />
    </el-form-item>

    <el-form-item
      :label="i18next.t('uds.hardware.canBridge.labels.sideA')"
      prop="sideADeviceKey"
      required
    >
      <div style="display: flex; align-items: center; gap: 8px; width: 100%">
        <el-select v-model="data.sideADeviceKey" style="flex: 1">
          <el-option
            v-for="item in canDeviceOptions"
            :key="item.key"
            :label="`${item.name} (${item.vendor})`"
            :value="item.key"
          />
        </el-select>
        <el-tag v-if="staleSideA" type="danger" size="small">
          {{ i18next.t('uds.hardware.canBridge.validation.deviceNotFound') }}
        </el-tag>
      </div>
    </el-form-item>

    <el-form-item
      :label="i18next.t('uds.hardware.canBridge.labels.sideB')"
      prop="sideBDeviceKey"
      required
    >
      <div style="display: flex; align-items: center; gap: 8px; width: 100%">
        <el-select v-model="data.sideBDeviceKey" style="flex: 1">
          <el-option
            v-for="item in canDeviceOptions"
            :key="item.key"
            :label="`${item.name} (${item.vendor})`"
            :value="item.key"
          />
        </el-select>
        <el-tag v-if="staleSideB" type="danger" size="small">
          {{ i18next.t('uds.hardware.canBridge.validation.deviceNotFound') }}
        </el-tag>
      </div>
    </el-form-item>

    <el-divider content-position="left">
      {{ i18next.t('uds.hardware.canBridge.sections.filter') }}
    </el-divider>

    <el-form-item :label="i18next.t('uds.hardware.canBridge.labels.enableFilter')">
      <el-checkbox v-model="enableFilter" />
      <span class="filter-hint">{{ i18next.t('uds.hardware.canBridge.hints.filterHint') }}</span>
    </el-form-item>

    <el-form-item v-if="enableFilter" label="CAN IDs (hex)">
      <el-input
        v-model="filterIdsText"
        :placeholder="i18next.t('uds.hardware.canBridge.placeholders.filterIds')"
      />
    </el-form-item>

    <el-divider />

    <el-form-item label-width="0">
      <div style="text-align: left; width: 100%">
        <el-button v-if="editIndex == ''" type="primary" plain @click="onSubmit">
          {{ i18next.t('uds.hardware.canBridge.buttons.addBridge') }}
        </el-button>
        <el-button v-else type="warning" plain @click="onSubmit">
          {{ i18next.t('uds.hardware.canBridge.buttons.saveBridge') }}
        </el-button>
      </div>
    </el-form-item>
  </el-form>
</template>

<script lang="ts" setup>
import { computed, onBeforeMount, ref } from 'vue'
import { v4 } from 'uuid'
import { type FormRules, type FormInstance } from 'element-plus'
import { cloneDeep } from 'lodash'
import { useDataStore } from '@r/stores/data'
import { useGlobalStart } from '@r/stores/runtime'
import i18next from 'i18next'
import type { CanBridgeInfo } from 'src/preload/data'

const props = defineProps<{
  index: string
}>()

const formRef = ref<FormInstance>()
const devices = useDataStore()
const globalStart = useGlobalStart()

const data = ref<CanBridgeInfo>({
  id: '',
  name: '',
  sideADeviceKey: '',
  sideBDeviceKey: '',
  filterIds: []
})

const enableFilter = ref(false)
const filterIdsText = ref('')

// Build list of CAN devices for selection
const canDeviceOptions = computed(() => {
  const options: { key: string; name: string; vendor: string }[] = []
  for (const key of Object.keys(devices.devices)) {
    const device = devices.devices[key]
    if (device.type === 'can' && device.canDevice) {
      options.push({
        key,
        name: device.canDevice.name,
        vendor: device.canDevice.vendor
      })
    }
  }
  return options
})

// Detect stale device references (device was deleted but bridge still points to it)
const staleSideA = computed(() => {
  return (
    data.value.sideADeviceKey &&
    !canDeviceOptions.value.some((opt) => opt.key === data.value.sideADeviceKey)
  )
})
const staleSideB = computed(() => {
  return (
    data.value.sideBDeviceKey &&
    !canDeviceOptions.value.some((opt) => opt.key === data.value.sideBDeviceKey)
  )
})

const editIndex = ref(props.index)
const emits = defineEmits(['change'])

const nameCheck = (_rule: any, value: any, callback: any) => {
  if (value) {
    for (const id of Object.keys(devices.bridges)) {
      const hasName = devices.bridges[id]?.name
      if (hasName === value && id !== editIndex.value) {
        callback(new Error(i18next.t('uds.hardware.canBridge.validation.nameExists')))
      }
    }
    callback()
  } else {
    callback(new Error(i18next.t('uds.hardware.canBridge.validation.inputName')))
  }
}

const sideCheck = (_rule: any, value: any, callback: any) => {
  if (!value) {
    callback(new Error(i18next.t('uds.hardware.canBridge.validation.selectDevice')))
  } else if (data.value.sideADeviceKey === data.value.sideBDeviceKey) {
    callback(new Error(i18next.t('uds.hardware.canBridge.validation.sameDevice')))
  } else if (staleSideA.value || staleSideB.value) {
    callback(new Error(i18next.t('uds.hardware.canBridge.validation.deviceNotFound')))
  } else {
    callback()
  }
}

const rules: FormRules<CanBridgeInfo> = {
  name: [{ required: true, trigger: 'blur', validator: nameCheck }],
  sideADeviceKey: [{ required: true, trigger: 'change', validator: sideCheck }],
  sideBDeviceKey: [{ required: true, trigger: 'change', validator: sideCheck }]
}

onBeforeMount(() => {
  if (editIndex.value) {
    const editData = devices.bridges[editIndex.value]
    if (editData) {
      data.value = cloneDeep(editData)
      if (data.value.filterIds && data.value.filterIds.length > 0) {
        enableFilter.value = true
        filterIdsText.value = data.value.filterIds
          .map((id) => '0x' + id.toString(16).toUpperCase())
          .join(', ')
      }
    } else {
      // New bridge — reset index to empty
      data.value.name = `Bridge_${Object.keys(devices.bridges).length + 1}`
      editIndex.value = ''
    }
  }
})

function parseFilterIds(): number[] {
  if (!enableFilter.value || !filterIdsText.value.trim()) {
    return []
  }
  const ids: number[] = []
  for (const part of filterIdsText.value.split(/[,;\s]+/)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const parsed = parseInt(trimmed, 16)
    if (!isNaN(parsed)) {
      ids.push(parsed)
    }
  }
  return ids
}

const onSubmit = () => {
  formRef.value?.validate((valid) => {
    if (valid) {
      if (enableFilter.value) {
        data.value.filterIds = parseFilterIds()
      } else {
        data.value.filterIds = []
      }
      if (editIndex.value === '') {
        const id = v4()
        data.value.id = id
        devices.bridges[id] = cloneDeep(data.value)
        emits('change', id, data.value.name)
      } else {
        data.value.id = editIndex.value
        devices.bridges[editIndex.value] = cloneDeep(data.value)
        emits('change', editIndex.value, data.value.name)
      }
    }
  })
}

// Expose save method for parent component to call
function save() {
  return new Promise<boolean>((resolve) => {
    formRef.value?.validate((valid) => {
      if (valid) {
        if (enableFilter.value) {
          data.value.filterIds = parseFilterIds()
        } else {
          data.value.filterIds = []
        }
        if (editIndex.value === '') {
          const id = v4()
          data.value.id = id
          devices.bridges[id] = cloneDeep(data.value)
          emits('change', id, data.value.name)
        } else {
          data.value.id = editIndex.value
          devices.bridges[editIndex.value] = cloneDeep(data.value)
          emits('change', editIndex.value, data.value.name)
        }
        resolve(true)
      } else {
        resolve(false)
      }
    })
  })
}
defineExpose({ save })
</script>

<style scoped>
.hardware {
  margin: 20px;
}
.filter-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
