import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parse3MF } from './threeMfIO';

const PRODUCTION_ROOT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"
  requiredextensions="p">
  <resources>
    <object id="2" name="Linked assembly" type="model">
      <components>
        <component objectid="1" p:path="/3D/Objects/triangle.model" transform="1 0 0 0 1 0 0 0 1 10 20 30" />
      </components>
    </object>
  </resources>
  <build><item objectid="2" /></build>
</model>`;

const PRODUCTION_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" name="External triangle" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0" />
          <vertex x="2" y="0" z="0" />
          <vertex x="0" y="2" z="0" />
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2" /></triangles>
      </mesh>
    </object>
  </resources>
</model>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

const MODEL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <basematerials id="5">
      <base name="Red" displaycolor="#ff0000ff" />
    </basematerials>
    <object id="1" name="Triangle" type="model" pid="5" pindex="0">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0" />
          <vertex x="1" y="0" z="0" />
          <vertex x="0" y="1" z="0" />
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2" /></triangles>
      </mesh>
    </object>
    <object id="2" name="Assembly" type="model">
      <components>
        <component objectid="1" transform="1 0 0 0 1 0 0 0 1 1 0 0" />
      </components>
    </object>
  </resources>
  <build>
    <item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 2 0" />
  </build>
</model>`;

describe('3MF parser', () => {
  it('loads assemblies, transforms, units, and base-material colours', async () => {
    const zip = new JSZip();
    zip.file('3D/3dmodel.model', MODEL_XML);
    const bytes = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parse3MF(bytes);

    expect(result.positions).toHaveLength(9);
    expect(result.positions[0]).toBeCloseTo(25.4, 4);
    expect(result.positions[1]).toBeCloseTo(50.8, 4);
    expect(result.positions[3]).toBeCloseTo(50.8, 4);
    expect(result.colors).toBeDefined();
    expect(Array.from(result.colors!)).toEqual([1, 0, 0]);
    expect(result.materials[0]).toMatchObject({ name: 'Red', triangles: 1 });
    expect(result.objectCount).toBe(2);
    expect(result.notes.join(' ')).toContain('converted to millimetres');
  });

  it('resolves Production-extension components stored in linked model parts', async () => {
    const zip = new JSZip();
    zip.file('_rels/.rels', ROOT_RELS_XML);
    zip.file('3D/3dmodel.model', PRODUCTION_ROOT_XML);
    zip.file('3D/Objects/triangle.model', PRODUCTION_OBJECT_XML);
    const bytes = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parse3MF(bytes);

    expect(result.positions).toHaveLength(9);
    expect(Array.from(result.positions.slice(0, 3))).toEqual([10, 20, 30]);
    expect(Array.from(result.positions.slice(3, 6))).toEqual([12, 20, 30]);
    expect(result.objectCount).toBe(2);
    expect(result.notes.join(' ')).toContain('2 linked 3MF model part(s) resolved');
  });
});
