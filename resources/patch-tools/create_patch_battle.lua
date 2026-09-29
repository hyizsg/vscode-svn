
local function isEmpty( t )
	-- body
	for k,v in pairs(t) do
		return false
	end
	return true
end


local function vardump(object, label)
    local lookupTable = {}
    local result = {}

    local function _v(v)
        if type(v) == "string" then
            v = "[[" .. v .. "]]"
        elseif type(v) == "number" then
            if v % 1 == 0 then
                return string.format("%0.18g", v)
            end
            return string.format("%f", v)
        end
        return tostring(v)
    end

    local function _vardump(object, label, indent, nest)
        label = label or "<var>"
        local postfix = ""
        if nest > 1 then postfix = "," end
        if type(object) ~= "table" then
            if type(label) == "string" then
                result[#result +1] = string.format("%s%s = %s%s", indent, label, _v(object), postfix)
            elseif type(label) == "number" then
                result[#result +1] = string.format("%s[%s] = %s%s", indent, label, _v(object), postfix)
            else
                result[#result +1] = string.format("%s%s%s", indent, _v(object), postfix)
            end
        elseif not lookupTable[object] then
            lookupTable[object] = true

            if type(label) == "string" then
                result[#result +1 ] = string.format("%s%s = {", indent, label)
            else
                result[#result +1 ] = string.format("%s[%s] = {", indent, label)
            end
            local indent2 = indent .. "    "
            local keys = {}
            local values = {}
            for k, v in pairs(object) do
                keys[#keys + 1] = k
                values[k] = v
            end
            table.sort(keys, function(a, b)
                if type(a) == "number" and type(b) == "number" then
                    return a < b
                else
                    return tostring(a) < tostring(b)
                end
            end)
            for i, k in ipairs(keys) do
                _vardump(values[k], k, indent2, nest + 1)
            end
            result[#result +1] = string.format("%s}%s", indent, postfix)
        end
    end
    _vardump(object, label, "", 1)

    return table.concat(result, "\n")
end

------------------------------------------------
local fileList = {}
for i = 1, #arg do
    fileList[#fileList + 1] = arg[i]
end

local function tNum(tab)
    local maxValue = 0
    for k, v in pairs( tab ) do
        maxValue = maxValue + 1
    end
    return maxValue
end

local function startGen(fileName)
    local old = require("old."..fileName)
    local new = require("new."..fileName)

    local newList = new["list"] or new
    local newIndexMap = new["index_map"] or {}
    if not newList or not newIndexMap then return "" end

    local oldList = old["list"] or old
    local oldIndexMap = old["index_map"] or {}

    local patchList = {}
    local patchIndex = {}
    local delList = {}
    local delIndex = {}
    local listLength = ((new["list_length"] or 0) ~= (old["list_length"] or 0)) and new["list_length"] or nil

    if #newList ~= tNum(newList) then 
        for k, v in pairs( newList ) do
            local arrNew = newList[k]
            local arrOld = oldList[k]
            for j=1,#arrNew do
                if arrOld == nil or arrNew[j] ~= arrOld[j] then
                    if patchList[k] == nil then
                        patchList[k] = {}
                    end
                    patchList[k][j] = arrNew[j]
                end
            end
        end

        for k,v in pairs(newIndexMap) do
            if oldIndexMap[k] ~= v then
                patchIndex[k] = v
            end
        end 
    else
        -- 变更/新增
        if #newList >= #oldList then
            for i=1,#newList do
                local arrNew = newList[i]
                local arrOld = oldList[i]
                for j=1,#arrNew do
                    if arrOld == nil or arrNew[j] ~= arrOld[j] then
                        if patchList[i] == nil then
                            patchList[i] = {}
                        end
                        patchList[i][j] = arrNew[j]
                    end
                end
            end

            for k,v in pairs(newIndexMap) do
                if oldIndexMap[k] ~= v then
                    patchIndex[k] = v
                end
            end 

        -- 删除
        else
            for i=1,#oldList do
                local arrNew = newList[i]
                local arrOld = oldList[i]
                if arrNew == nil then
                    delList[i] = i
                else
                    for j=1,#arrNew do
                        if arrNew[j] ~= arrOld[j] then
                            if patchList[i] == nil then
                                patchList[i] = {}
                            end
                            patchList[i][j] = arrNew[j]
                        end
                    end
                end
            end

            for k,v in pairs(oldIndexMap) do
                if newIndexMap[k] and newIndexMap[k] ~= v then
                    patchIndex[k] = newIndexMap[k]
                elseif newIndexMap[k] == nil then
                    delIndex[k] = k
                end
            end
        end
    end

    -- 表头
    local hasUpdate = not isEmpty(patchList)        -- list更新/增加
    local hasIndexUpdate = not isEmpty(patchIndex)  -- index更新/增加
    local hasDel = not isEmpty(delList)             -- list删除
    local hasIndexDel = not isEmpty(delIndex)       -- index删除
    local str = [[
local #file_name# = require("battle.cfg.#file_name#")
]]
    if hasDel or hasUpdate then 
        str = str..[[
local list = #file_name#["list"] or #file_name#
]]
    end
    if hasIndexDel or hasIndexUpdate then 
        str = str..[[
local index_map = #file_name#["index_map"]
]]
    end
    str = string.gsub(str,"#file_name#",fileName)

    -- 更新/增加 数据
    local strList,strIndex,strDelList,strDelIndex = "", "", "", ""
    if hasUpdate or hasIndexUpdate then
        local strUpdate = ""
        if hasUpdate then
            strList = vardump(patchList,"","")
            strUpdate = [[
local list_update#strList#
for k,v in pairs(list_update) do
    list[k] = list[k] or {}
    for kk,vv in pairs(v) do
        list[k][kk] = vv
    end
end
]]
        end

    	if hasIndexUpdate then
            strIndex = vardump(patchIndex,"","")
            strUpdate = strUpdate..[[
local index_update#strIndex#
for k,v in pairs(index_update) do
    index_map[k] = index_update[k]
end
]]
        end 

        str = str..strUpdate 
        strList = string.gsub(strList,"%%","%%%%")
        str = string.gsub(str,"#strList#",strList)
        str = string.gsub(str,"#strIndex#",strIndex)
    end

    ---删除 数据
    if hasDel or hasIndexDel then
        local strDel = ""
        if hasDel then
            strDelList = vardump(delList,"","")
            strDel = [[
local list_del#strDelList#
for k,v in pairs(list_del) do
    list[k] = nil
end
]]
        end
        
        if hasIndexDel then
            strDelIndex = vardump(delIndex,"","")   
            strDel = strDel..[[
local index_del#strDelIndex#
for k,v in pairs(index_del) do
    index_map[k] = nil
end
]]
        end
        str = str..strDel 
        str = string.gsub(str,"#strDelList#",strDelList)
        str = string.gsub(str,"#strDelIndex#",strDelIndex)
    end

    -- 长度变化
    if listLength then
        str = str..fileName.."['list_length']" .. " = " .. listLength.."\n"
    end
    
    if hasUpdate or hasIndexUpdate or hasDel or hasIndexDel then
        return str
    else
        return ""
    end
end


local file = io.open("patch_battle.lua","w+", "utf-8")
local strPatch = ""

-- 缓存清理
if #fileList > 0 then
    strPatch = strPatch .. "\n" .. "--[["
    strPatch = strPatch .. "\n" .. "	start"
    strPatch = strPatch .. "\n" .. "	修改者："
    strPatch = strPatch .. "\n" .. "	已提交："
    strPatch = strPatch .. "\n" .. "]]\n"
    
    strPatch = strPatch .. "\n" .. "-- 清理1：战斗缓存"
    strPatch = strPatch .. "\n" .. 'local ConfigCache = require("battle.data.ConfigCache")'
	strPatch = strPatch .. "\n" .. 'local configCache = ConfigCache.getInstance()'
    strPatch = strPatch .. "\n" .. 'configCache:resetCache()\n'

    strPatch = strPatch .. "\n" .. "--[["
    strPatch = strPatch .. "\n" .. "    清理2：配置缓存（****特别说明：这部分不能重复清理，防止出错）"
    strPatch = strPatch .. "\n" .. "    缓存的表可能是:"
    strPatch = strPatch .. "\n" .. "        集合表: 集合了各种同类型的表，他们的索引是互斥的。统一使用集合表进行索引。集合表内部缓存了二级表的数据。例如battle_monster_info"
    strPatch = strPatch .. "\n" .. "        总表：一个配置文件导出时分成了多个子表 和 一个总表。统一使用总表的名字进行索引。总表的原表里缓存了子表的数据。例如battle_boss_info"
    strPatch = strPatch .. "\n" .. "        单表：只有一个独立的表，好处理"
    strPatch = strPatch .. "\n" .. "]] "
    strPatch = strPatch .. "\n" .. 'local BattleCfgReader = require("battle.data.BattleCfgReader")'
	strPatch = strPatch .. "\n" .. 'for cfgName, v in pairs( BattleCfgReader._cacheData or {} ) do'
    strPatch = strPatch .. "\n" .. '    local newName = string.format("battle.cfg.battle_%s",cfgName)'
    strPatch = strPatch .. "\n" .. '    package.loaded[newName] = nil'
    strPatch = strPatch .. "\n" .. 'end'
    strPatch = strPatch .. "\n" .. 'BattleCfgReader._cacheData = {}\n'
    
    strPatch = strPatch .. "\n" .. "--[["
    strPatch = strPatch .. "\n" .. "    清理3：修改的表 和 与它关联的总表"
    strPatch = strPatch .. "\n" .. "    修改表：部分战斗配置文件在加载后，会添加很多辅助字段，并赋值。所以每个修改的文件都需要清理"
    strPatch = strPatch .. "\n" .. "    总表：清理2中集合表中可能包含有总表，如果修改只发生在子表中，即使重新加载集合表，总表的内容也依然没变，其原表中可能缓存有子表数据，所以需要同时对总表做清理"
    strPatch = strPatch .. "\n" .. "]] "
    
    local hash = {}
    for i=1,#fileList do
        local fileName = string.gsub(fileList[i],".lua","")
        
        -- 总表
        local index = string.find(fileName, "_%d")
        if index then
            local shortName = string.sub(fileName, 1, index-1)
            if not hash[shortName] then
                hash[shortName] = true
                strPatch = strPatch .. "\n" .. 'package.loaded["battle.cfg.'.. shortName .. '"] = nil'
            end    
        end
        
        -- 分表/单表
        if fileName and not hash[fileName] then
            hash[fileName] = true
            strPatch = strPatch .. "\n" .. 'package.loaded["battle.cfg.'.. fileName .. '"] = nil'
        end
    end
    strPatch = strPatch .. "\n\n"
end

for i=1,#fileList do
    local fileName = string.gsub(fileList[i],".lua","")
    strPatch = strPatch..startGen(fileName) 
    if i < #fileList then
        strPatch = strPatch.."--------------------------------------------------\n"
    end
end

if #fileList > 0 then
    strPatch = strPatch .. "\n" .. "--[["
    strPatch = strPatch .. "\n" .. "	end"
    strPatch = strPatch .. "\n" .. "	修改者："
    strPatch = strPatch .. "\n" .. "	已提交："
    strPatch = strPatch .. "\n" .. "]]\n"
end 

file:write(strPatch)
file:close()
print("success ====================== ")